const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const util = require('../util.js');
const fs = require('fs');
const os = require('os');
const url = require('url');

const chrome = exports = module.exports = {};

chrome.name = 'Chrome';



chrome.spawn = function(options) {
	return new Promise((resolve, reject) => {
		this.options = options;
		let location = this.getChromeLocation();

		if (!fs.existsSync(location)) {
			util.log('unable to find Chrome install. Please specify with chromeLocation');
			return reject();
		}

		this.chromeChild = spawn(location, this.options.chromeFlags || [
			'--headless',
			'--disable-gpu',
			'--remote-debugging-port=' + this.options.browserDebuggingPort,
			'--hide-scrollbars',
		]);

		resolve();
	});
};



chrome.onClose = function(callback) {
	this.chromeChild.on('close', callback);
};



chrome.kill = function() {
	if (this.chromeChild) {
		this.chromeChild.kill('SIGINT');
	}
};



chrome.connect = function() {
	return new Promise((resolve, reject) => {
		let connected = false;
		let timeout = setTimeout(() => {
			if (!connected) {
				reject();
			}
		}, 20 * 1000);

		let connect = () => {
			CDP.Version({ port: this.options.browserDebuggingPort }).then((info) => {

				this.originalUserAgent = info['User-Agent'];
				this.webSocketDebuggerURL = info.webSocketDebuggerUrl || 'ws://localhost:' + this.options.browserDebuggingPort + '/devtools/browser';
				this.version = info.Browser;

				clearTimeout(timeout);
				connected = true;
				resolve();

			}).catch((err) => {
				util.log('retrying connection to Chrome...');
				return setTimeout(connect, 1000);
			});
		};

		setTimeout(connect, 500);

	});
};



chrome.getChromeLocation = function() {
	if (this.options.chromeLocation) {
		return this.options.chromeLocation;
	}

	let platform = os.platform();

	if (platform === 'darwin') {
		return '/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome';
	}

	if (platform === 'linux') {
		return '/usr/bin/google-chrome';
	}

	if (platform === 'win32') {
		return 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
	}
};



chrome.openTab = function(options) {
	return new Promise((resolve, reject) => {

		let browserContext = null;
		let browser = null;

		CDP({ target: this.webSocketDebuggerURL, port: this.options.browserDebuggingPort })
		.then((chromeBrowser) => {
			browser = chromeBrowser;

			return browser.Target.createBrowserContext();
		}).then(({ browserContextId }) => {

			browserContext = browserContextId;

			return browser.Target.createTarget({
				url: 'about:blank',
				browserContextId
			});
		}).then(({ targetId }) => {

			return CDP({ target: targetId, port: this.options.browserDebuggingPort });
		}).then((tab) => {

			//we're going to put our state on the chrome tab for now
			//we should clean this up later
			tab.browserContextId = browserContext;
			tab.browser = browser;
			tab.prerender = options;
			tab.prerender.requests = {};
			tab.prerender.numRequestsInFlight = 0;

			return this.setUpEvents(tab);
		}).then((tab) => {

			resolve(tab);
		}).catch((err) => { reject(err) });
	});
};



chrome.closeTab = function(tab) {
	return new Promise((resolve, reject) => {

		tab.browser.Target.closeTarget({targetId: tab.target})
		.then(() => {

			return tab.browser.Target.disposeBrowserContext({ browserContextId: tab.browserContextId });
		}).then(() => {

			return tab.browser.close();
		}).then(() => {

			resolve();
		}).catch((err) => {
			reject(err);
		});
	});
};



chrome.setUpEvents = function(tab) {
	return new Promise((resolve, reject) => {

		const {
			Page,
			Security,
			DOM,
			Network,
			Emulation,
			Log,
			Console
		} = tab;

		Promise.all([
			DOM.enable(),
			Page.enable(),
			Security.enable(),
			Network.enable(),
			Log.enable(),
			Console.enable()
		]).then(() => {

			//hold onto info that could be used later if saving a HAR file
			tab.prerender.pageLoadInfo = {
				url: tab.prerender.url,
				firstRequestId: undefined,
				firstRequestMs: undefined,
				domContentEventFiredMs: undefined,
				loadEventFiredMs: undefined,
				entries: {},
				logEntries: [],
				user: undefined
			};

			Page.domContentEventFired(({timestamp}) => {
				tab.prerender.domContentEventFired = true;
				tab.prerender.pageLoadInfo.domContentEventFiredMs = timestamp * 1000;
			});

			Page.loadEventFired(({timestamp}) => {
				tab.prerender.pageLoadInfo.loadEventFiredMs = timestamp * 1000;
			});

			//if the page opens up a javascript dialog, lets try to close it after 1s
			Page.javascriptDialogOpening(() => {
				setTimeout(() => {
					Page.handleJavaScriptDialog({accept: true});
				}, 1000);
			});

			Security.certificateError(({eventId}) => {
				Security.handleCertificateError({
					eventId,
					action: 'continue'
				}).catch((err) => {
					util.log('error handling certificate error:', err);
				});
			});

			Security.setOverrideCertificateErrors({override: true});

			Network.setUserAgentOverride({
				userAgent: tab.prerender.userAgent || this.options.userAgent || this.originalUserAgent + ' Prerender (+https://github.com/prerender/prerender)'
			});

			var bypassServiceWorker = !(this.options.enableServiceWorker == true || this.options.enableServiceWorker == 'true');

			if (typeof tab.prerender.enableServiceWorker !== 'undefined') {
				bypassServiceWorker = !tab.prerender.enableServiceWorker;
			}

			Network.setBypassServiceWorker({bypass: bypassServiceWorker})

			Network.requestWillBeSent((params) => {
				tab.prerender.numRequestsInFlight++;
				tab.prerender.requests[params.requestId] = params.request.url;
				if (tab.prerender.logRequests || this.options.logRequests) util.log('+', tab.prerender.numRequestsInFlight, params.request.url);

				if (!tab.prerender.initialRequestId) {
					tab.prerender.initialRequestId = params.requestId;
					tab.prerender.pageLoadInfo.firstRequestId = params.requestId;
					tab.prerender.pageLoadInfo.firstRequestMs = params.timestamp * 1000;
				}

				tab.prerender.pageLoadInfo.entries[params.requestId] = {
					requestParams: params,
					responseParams: undefined,
					responseLength: 0,
					encodedResponseLength: undefined,
					responseFinishedS: undefined,
					responseFailedS: undefined,
					responseBody: undefined,
					responseBodyIsBase64: undefined,
					newPriority: undefined
				};

				if (params.redirectResponse) {
					//during a redirect, we don't get the responseReceived event for the original request,
					//so lets decrement the number of requests in flight here.
					//the original requestId is also reused for the redirected request
					tab.prerender.numRequestsInFlight--;

					let redirectEntry = tab.prerender.pageLoadInfo.entries[params.requestId];
					redirectEntry.responseParams = {
						response: params.redirectResponse
					};
					redirectEntry.responseFinishedS = params.timestamp;
					redirectEntry.encodedResponseLength = params.redirectResponse.encodedDataLength;

					if (tab.prerender.initialRequestId === params.requestId && !tab.prerender.followRedirects && !this.options.followRedirects) {
						tab.prerender.receivedRedirect = true; //initial response of a 301 gets modified so we need to capture that we saw a redirect here
						tab.prerender.lastRequestReceivedAt = new Date().getTime();
						tab.prerender.statusCode = params.redirectResponse.status;
						tab.prerender.headers = params.redirectResponse.headers;
						tab.prerender.content = params.redirectResponse.statusText;

						Page.stopLoading();
					}
				}
			});

			Network.dataReceived(({requestId, dataLength}) => {
				let entry = tab.prerender.pageLoadInfo.entries[requestId];
				if (!entry) {
					return;
				}
				entry.responseLength += dataLength;
			});

			Network.responseReceived((params) => {
				let entry = tab.prerender.pageLoadInfo.entries[params.requestId];
				if (entry) {
					entry.responseParams = params;
				}

				if (params.requestId == tab.prerender.initialRequestId && !tab.prerender.receivedRedirect) {

					tab.prerender.statusCode = params.response.status;
					tab.prerender.headers = params.response.headers;

					//if we get a 304 from the server, turn it into a 200 on our end
					if(tab.prerender.statusCode == 304) tab.prerender.statusCode = 200;
				}
			});

			Network.resourceChangedPriority(({requestId, newPriority}) => {
				let entry = tab.prerender.pageLoadInfo.entries[requestId];
				if (!entry) {
					return;
				}
				entry.newPriority = newPriority;
			});

			Network.loadingFinished(({requestId, timestamp, encodedDataLength}) => {
				if(tab.prerender.requests[requestId]) {
					tab.prerender.numRequestsInFlight--;
					tab.prerender.lastRequestReceivedAt = new Date().getTime();

					if (tab.prerender.logRequests || this.options.logRequests) util.log('-', tab.prerender.numRequestsInFlight, tab.prerender.requests[requestId]);
					delete tab.prerender.requests[requestId];

					let entry = tab.prerender.pageLoadInfo.entries[requestId];
					if (!entry) {
						return;
					}
					entry.encodedResponseLength = encodedDataLength;
					entry.responseFinishedS = timestamp;
				}
			});

			//when a redirect happens and we call Page.stopLoading,
			//all outstanding requests will fire this event
			Network.loadingFailed((params) => {
				if(tab.prerender.requests[params.requestId]) {
					tab.prerender.numRequestsInFlight--;
					if (tab.prerender.logRequests || this.options.logRequests) util.log('-', tab.prerender.numRequestsInFlight, tab.prerender.requests[params.requestId]);
					delete tab.prerender.requests[params.requestId];

					let entry = tab.prerender.pageLoadInfo.entries[params.requestId];
					if (entry) {
						entry.responseFailedS = params.timestamp;
					}
				}
			});

			// <del>Console is deprecated, kept for backwards compatibility</del>
			// It's still in use and can't get console-log from Log.entryAdded event
			Console.messageAdded((params) => {
				if (tab.prerender.captureConsoleLog || this.options.captureConsoleLog) {
					const message = params.message;

					tab.prerender.pageLoadInfo.logEntries.push({
						...message,
						// to keep consistent with Log.LogEntry 
						lineNumber: message.line,
						timestamp: new Date().getTime()
					});
				}

				if (tab.prerender.logRequests || this.options.logRequests) {
					const message = params.message;
					util.log('level:', message.level, 'text:', message.text, 'url:', message.url, 'line:', message.line);
				}
			});

			Log.entryAdded((params) => {
				tab.prerender.pageLoadInfo.logEntries.push(params.entry);
				if (tab.prerender.logRequests || this.options.logRequests) util.log(params.entry);
			});

			resolve(tab);
		}).catch((err) => {
			reject(err);
		});
	});
};



chrome.loadUrlThenWaitForPageLoadEvent = function(tab, url, injectShadyDOM) {
	return new Promise((resolve, reject) => {
		tab.prerender.url = url;

		var finished = false;
		const {
			Page,
			Emulation
		} = tab;


		Page.enable()
		.then(() => {

			let pageDoneCheckInterval = tab.prerender.pageDoneCheckInterval || this.options.pageDoneCheckInterval;
			let pageLoadTimeout = tab.prerender.pageLoadTimeout || this.options.pageLoadTimeout;

			var checkIfDone = () => {
				if (finished) {return;}

				if ((tab.prerender.renderType === 'jpeg' || tab.prerender.renderType === 'png') && tab.prerender.fullpage) {
					tab.Runtime.evaluate({
						expression: 'window.scrollBy(0, window.innerHeight);'
					});
				}


				this.checkIfPageIsDoneLoading(tab).then((doneLoading) => {
					if (doneLoading && !finished) {
						finished = true;

						if ((tab.prerender.renderType === 'jpeg' || tab.prerender.renderType === 'png') && tab.prerender.fullpage) {
							tab.Runtime.evaluate({
								expression: 'window.scrollTo(0, 0);'
							});
						}

						resolve();
					}

					if (!doneLoading && !finished) {
						setTimeout(checkIfDone, pageDoneCheckInterval);
					}
				}).catch((e) => {
					finished = true;
					util.log('Chrome connection closed during request');
					tab.prerender.statusCode = 504;
					reject();
				});
			};

			setTimeout(() => {
				if (!finished) {
					finished = true;
					util.log('page timed out', tab.prerender.url);
					resolve();
				}
			}, pageLoadTimeout);

			Page.addScriptToEvaluateOnNewDocument({source: 'if (window.customElements) customElements.forcePolyfill = true'})
			Page.addScriptToEvaluateOnNewDocument({source: 'ShadyDOM = {force: true}'})
			Page.addScriptToEvaluateOnNewDocument({source: 'ShadyCSS = {shimcssproperties: true}'})

      if (injectShadyDOM) {
        addShadyDOM(Page);
      }

			let width = parseInt(tab.prerender.width, 10) || 1440;
			let height = parseInt(tab.prerender.height, 10) || 718;

			Emulation.setDeviceMetricsOverride({
				width: width,
				screenWidth: width,
				height: height,
				screenHeight: height,
				deviceScaleFactor: 0,
				mobile: false
			});

			Page.navigate({
				url: tab.prerender.url
			}).then(() => {
				setTimeout(checkIfDone, pageDoneCheckInterval);
			}).catch(() => {
				util.log('invalid URL sent to Chrome:', tab.prerender.url);
				tab.prerender.statusCode = 504;
				finished = true;
				reject();
			});
		}).catch((err) => {
			util.log('unable to load URL', err);
			tab.prerender.statusCode = 504;
			finished = true;
			reject();
		});
	});
};

function addShadyDOM(Page) {
  // TODO: this is fugly; figure out a better way. Injecting a <script> in the headless DOM's <head> doesn't work.
  Page.addScriptToEvaluateOnNewDocument({
    source: `(function(){/*
Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
'use strict';var n;function aa(a){var b=0;return function(){return b<a.length?{done:!1,value:a[b++]}:{done:!0}}}function ba(a){var b="undefined"!=typeof Symbol&&Symbol.iterator&&a[Symbol.iterator];return b?b.call(a):{next:aa(a)}}function p(a){if(!(a instanceof Array)){a=ba(a);for(var b,c=[];!(b=a.next()).done;)c.push(b.value);a=c}return a}var ca="undefined"!=typeof window&&window===this?this:"undefined"!=typeof global&&null!=global?global:this;function q(a,b){return{index:a,s:[],v:b}}
function da(a,b,c,d){var e=0,f=0,g=0,h=0,m=Math.min(b-e,d-f);if(0==e&&0==f)a:{for(g=0;g<m;g++)if(a[g]!==c[g])break a;g=m}if(b==a.length&&d==c.length){h=a.length;for(var l=c.length,k=0;k<m-g&&ea(a[--h],c[--l]);)k++;h=k}e+=g;f+=g;b-=h;d-=h;if(0==b-e&&0==d-f)return[];if(e==b){for(b=q(e,0);f<d;)b.s.push(c[f++]);return[b]}if(f==d)return[q(e,b-e)];m=e;g=f;d=d-g+1;h=b-m+1;b=Array(d);for(l=0;l<d;l++)b[l]=Array(h),b[l][0]=l;for(l=0;l<h;l++)b[0][l]=l;for(l=1;l<d;l++)for(k=1;k<h;k++)if(a[m+k-1]===c[g+l-1])b[l][k]=
b[l-1][k-1];else{var r=b[l-1][k]+1,C=b[l][k-1]+1;b[l][k]=r<C?r:C}m=b.length-1;g=b[0].length-1;d=b[m][g];for(a=[];0<m||0<g;)0==m?(a.push(2),g--):0==g?(a.push(3),m--):(h=b[m-1][g-1],l=b[m-1][g],k=b[m][g-1],r=l<k?l<h?l:h:k<h?k:h,r==h?(h==d?a.push(0):(a.push(1),d=h),m--,g--):r==l?(a.push(3),m--,d=l):(a.push(2),g--,d=k));a.reverse();b=void 0;m=[];for(g=0;g<a.length;g++)switch(a[g]){case 0:b&&(m.push(b),b=void 0);e++;f++;break;case 1:b||(b=q(e,0));b.v++;e++;b.s.push(c[f]);f++;break;case 2:b||(b=q(e,0));
b.v++;e++;break;case 3:b||(b=q(e,0)),b.s.push(c[f]),f++}b&&m.push(b);return m}function ea(a,b){return a===b};function fa(){}fa.prototype.toJSON=function(){return{}};function t(a){a.__shady||(a.__shady=new fa);return a.__shady}function u(a){return a&&a.__shady};var v=window.ShadyDOM||{};v.T=!(!Element.prototype.attachShadow||!Node.prototype.getRootNode);var ha=Object.getOwnPropertyDescriptor(Node.prototype,"firstChild");v.c=!!(ha&&ha.configurable&&ha.get);v.F=v.force||!v.T;v.g=v.noPatch||!1;v.o=v.preferPerformance;v.G="on-demand"===v.g;v.L=navigator.userAgent.match("Trident");function w(a){return(a=u(a))&&void 0!==a.firstChild}function x(a){return a instanceof ShadowRoot}function ia(a){return(a=(a=u(a))&&a.root)&&ja(a)}
var y=Element.prototype,ka=y.matches||y.matchesSelector||y.mozMatchesSelector||y.msMatchesSelector||y.oMatchesSelector||y.webkitMatchesSelector,la=document.createTextNode(""),ma=0,na=[];(new MutationObserver(function(){for(;na.length;)try{na.shift()()}catch(a){throw la.textContent=ma++,a;}})).observe(la,{characterData:!0});function oa(a){na.push(a);la.textContent=ma++}var pa=document.contains?function(a,b){return a.__shady_native_contains(b)}:function(a,b){return a===b||a.documentElement&&a.documentElement.__shady_native_contains(b)};
function qa(a,b){for(;b;){if(b==a)return!0;b=b.__shady_parentNode}return!1}function z(a){for(var b=a.length-1;0<=b;b--){var c=a[b],d=c.getAttribute("id")||c.getAttribute("name");d&&"length"!==d&&isNaN(d)&&(a[d]=c)}a.item=function(e){return a[e]};a.namedItem=function(e){if("length"!==e&&isNaN(e)&&a[e])return a[e];for(var f=ba(a),g=f.next();!g.done;g=f.next())if(g=g.value,(g.getAttribute("id")||g.getAttribute("name"))==e)return g;return null};return a}
function ra(a){var b=[];for(a=a.__shady_native_firstChild;a;a=a.__shady_native_nextSibling)b.push(a);return b}function sa(a){var b=[];for(a=a.__shady_firstChild;a;a=a.__shady_nextSibling)b.push(a);return b}function ta(a,b,c){c.configurable=!0;if(c.value)a[b]=c.value;else try{Object.defineProperty(a,b,c)}catch(d){}}function A(a,b,c,d){c=void 0===c?"":c;for(var e in b)d&&0<=d.indexOf(e)||ta(a,c+e,b[e])}function ua(a,b){for(var c in b)c in a&&ta(a,c,b[c])}
function B(a){var b={};Object.getOwnPropertyNames(a).forEach(function(c){b[c]=Object.getOwnPropertyDescriptor(a,c)});return b}function va(a,b){for(var c=Object.getOwnPropertyNames(b),d=0,e;d<c.length;d++)e=c[d],a[e]=b[e]}function wa(a){return a instanceof Node?a:document.createTextNode(""+a)}
function D(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];if(1===b.length)return wa(b[0]);c=document.createDocumentFragment();b=ba(b);for(var d=b.next();!d.done;d=b.next())c.appendChild(wa(d.value));return c};var E=[],xa;function ya(a){xa||(xa=!0,oa(F));E.push(a)}function F(){xa=!1;for(var a=!!E.length;E.length;)E.shift()();return a}F.list=E;var za=B({get childNodes(){return this.__shady_childNodes},get firstChild(){return this.__shady_firstChild},get lastChild(){return this.__shady_lastChild},get childElementCount(){return this.__shady_childElementCount},get children(){return this.__shady_children},get firstElementChild(){return this.__shady_firstElementChild},get lastElementChild(){return this.__shady_lastElementChild},get shadowRoot(){return this.__shady_shadowRoot}}),Aa=B({get textContent(){return this.__shady_textContent},set textContent(a){this.__shady_textContent=
a},get innerHTML(){return this.__shady_innerHTML},set innerHTML(a){return this.__shady_innerHTML=a}}),Ba=B({get parentElement(){return this.__shady_parentElement},get parentNode(){return this.__shady_parentNode},get nextSibling(){return this.__shady_nextSibling},get previousSibling(){return this.__shady_previousSibling},get nextElementSibling(){return this.__shady_nextElementSibling},get previousElementSibling(){return this.__shady_previousElementSibling},get className(){return this.__shady_className},
set className(a){return this.__shady_className=a}});function Ca(a){for(var b in a){var c=a[b];c&&(c.enumerable=!1)}}Ca(za);Ca(Aa);Ca(Ba);var Da=v.c||!0===v.g,Ea=Da?function(){}:function(a){var b=t(a);b.N||(b.N=!0,ua(a,Ba))},Fa=Da?function(){}:function(a){var b=t(a);b.M||(b.M=!0,ua(a,za),window.customElements&&window.customElements.polyfillWrapFlushCallback&&!v.g||ua(a,Aa))};var G="__eventWrappers"+Date.now(),Ga=function(){var a=Object.getOwnPropertyDescriptor(Event.prototype,"composed");return a?function(b){return a.get.call(b)}:null}(),Ha=function(){function a(){}var b=!1,c={get capture(){b=!0;return!1}};window.addEventListener("test",a,c);window.removeEventListener("test",a,c);return b}();function Ia(a){if(a&&"object"===typeof a){var b=!!a.capture;var c=!!a.once;var d=!!a.passive;var e=a.i}else b=!!a,d=c=!1;return{K:e,capture:b,once:c,passive:d,J:Ha?a:b}}
var Ja={blur:!0,focus:!0,focusin:!0,focusout:!0,click:!0,dblclick:!0,mousedown:!0,mouseenter:!0,mouseleave:!0,mousemove:!0,mouseout:!0,mouseover:!0,mouseup:!0,wheel:!0,beforeinput:!0,input:!0,keydown:!0,keyup:!0,compositionstart:!0,compositionupdate:!0,compositionend:!0,touchstart:!0,touchend:!0,touchmove:!0,touchcancel:!0,pointerover:!0,pointerenter:!0,pointerdown:!0,pointermove:!0,pointerup:!0,pointercancel:!0,pointerout:!0,pointerleave:!0,gotpointercapture:!0,lostpointercapture:!0,dragstart:!0,
drag:!0,dragenter:!0,dragleave:!0,dragover:!0,drop:!0,dragend:!0,DOMActivate:!0,DOMFocusIn:!0,DOMFocusOut:!0,keypress:!0},Ka={DOMAttrModified:!0,DOMAttributeNameChanged:!0,DOMCharacterDataModified:!0,DOMElementNameChanged:!0,DOMNodeInserted:!0,DOMNodeInsertedIntoDocument:!0,DOMNodeRemoved:!0,DOMNodeRemovedFromDocument:!0,DOMSubtreeModified:!0};function La(a){return a instanceof Node?a.__shady_getRootNode():a}
function H(a,b){var c=[],d=a;for(a=La(a);d;)c.push(d),d.__shady_assignedSlot?d=d.__shady_assignedSlot:d.nodeType===Node.DOCUMENT_FRAGMENT_NODE&&d.host&&(b||d!==a)?d=d.host:d=d.__shady_parentNode;c[c.length-1]===document&&c.push(window);return c}function Ma(a){a.__composedPath||(a.__composedPath=H(a.target,!0));return a.__composedPath}function Na(a,b){if(!x)return a;a=H(a,!0);for(var c=0,d,e=void 0,f,g=void 0;c<b.length;c++)if(d=b[c],f=La(d),f!==e&&(g=a.indexOf(f),e=f),!x(f)||-1<g)return d}
function Oa(a){function b(c,d){c=new a(c,d);c.__composed=d&&!!d.composed;return c}b.__proto__=a;b.prototype=a.prototype;return b}var Pa={focus:!0,blur:!0};function Qa(a){return a.__target!==a.target||a.__relatedTarget!==a.relatedTarget}function Ra(a,b,c){if(c=b.__handlers&&b.__handlers[a.type]&&b.__handlers[a.type][c])for(var d=0,e;(e=c[d])&&(!Qa(a)||a.target!==a.relatedTarget)&&(e.call(b,a),!a.__immediatePropagationStopped);d++);}
function Sa(a){var b=a.composedPath(),c=b.map(function(m){return Na(m,b)}),d=a.bubbles;Object.defineProperty(a,"currentTarget",{configurable:!0,enumerable:!0,get:function(){return g}});var e=Event.CAPTURING_PHASE;Object.defineProperty(a,"eventPhase",{configurable:!0,enumerable:!0,get:function(){return e}});for(var f=b.length-1;0<=f;f--){var g=b[f];e=g===c[f]?Event.AT_TARGET:Event.CAPTURING_PHASE;Ra(a,g,"capture");if(a.B)return}for(f=0;f<b.length;f++){g=b[f];var h=g===c[f];if(h||d)if(e=h?Event.AT_TARGET:
Event.BUBBLING_PHASE,Ra(a,g,"bubble"),a.B)return}e=0;g=null}function Ta(a,b,c,d,e,f){for(var g=0;g<a.length;g++){var h=a[g],m=h.type,l=h.capture,k=h.once,r=h.passive;if(b===h.node&&c===m&&d===l&&e===k&&f===r)return g}return-1}function Ua(a){F();return!v.o&&this instanceof Node&&!pa(document,this)?(a.__target||Va(a,this),Sa(a)):this.__shady_native_dispatchEvent(a)}
function Wa(a,b,c){var d=Ia(c),e=d.capture,f=d.once,g=d.passive,h=d.K;d=d.J;if(b){var m=typeof b;if("function"===m||"object"===m)if("object"!==m||b.handleEvent&&"function"===typeof b.handleEvent){if(Ka[a])return this.__shady_native_addEventListener(a,b,d);var l=h||this;if(h=b[G]){if(-1<Ta(h,l,a,e,f,g))return}else b[G]=[];h=function(k){f&&this.__shady_removeEventListener(a,b,c);k.__target||Va(k);if(l!==this){var r=Object.getOwnPropertyDescriptor(k,"currentTarget");Object.defineProperty(k,"currentTarget",
{get:function(){return l},configurable:!0});var C=Object.getOwnPropertyDescriptor(k,"eventPhase");Object.defineProperty(k,"eventPhase",{configurable:!0,enumerable:!0,get:function(){return e?Event.CAPTURING_PHASE:Event.BUBBLING_PHASE}})}k.__previousCurrentTarget=k.currentTarget;if(!x(l)&&"slot"!==l.localName||-1!=k.composedPath().indexOf(l))if(k.composed||-1<k.composedPath().indexOf(l))if(Qa(k)&&k.target===k.relatedTarget)k.eventPhase===Event.BUBBLING_PHASE&&k.stopImmediatePropagation();else if(k.eventPhase===
Event.CAPTURING_PHASE||k.bubbles||k.target===l||l instanceof Window){var R="function"===m?b.call(l,k):b.handleEvent&&b.handleEvent(k);l!==this&&(r?(Object.defineProperty(k,"currentTarget",r),r=null):delete k.currentTarget,C?(Object.defineProperty(k,"eventPhase",C),C=null):delete k.eventPhase);return R}};b[G].push({node:l,type:a,capture:e,once:f,passive:g,V:h});this.__handlers=this.__handlers||{};this.__handlers[a]=this.__handlers[a]||{capture:[],bubble:[]};this.__handlers[a][e?"capture":"bubble"].push(h);
Pa[a]||this.__shady_native_addEventListener(a,h,d)}}}
function Xa(a,b,c){if(b){var d=Ia(c);c=d.capture;var e=d.once,f=d.passive,g=d.K;d=d.J;if(Ka[a])return this.__shady_native_removeEventListener(a,b,d);var h=g||this;g=void 0;var m=null;try{m=b[G]}catch(l){}m&&(e=Ta(m,h,a,c,e,f),-1<e&&(g=m.splice(e,1)[0].V,m.length||(b[G]=void 0)));this.__shady_native_removeEventListener(a,g||b,d);g&&this.__handlers&&this.__handlers[a]&&(a=this.__handlers[a][c?"capture":"bubble"],b=a.indexOf(g),-1<b&&a.splice(b,1))}}
function Ya(){for(var a in Pa)window.__shady_native_addEventListener(a,function(b){b.__target||(Va(b),Sa(b))},!0)}
var Za=B({get composed(){void 0===this.__composed&&(Ga?this.__composed="focusin"===this.type||"focusout"===this.type||Ga(this):!1!==this.isTrusted&&(this.__composed=Ja[this.type]));return this.__composed||!1},composedPath:function(){this.__composedPath||(this.__composedPath=H(this.__target,this.composed));return this.__composedPath},get target(){return Na(this.currentTarget||this.__previousCurrentTarget,this.composedPath())},get relatedTarget(){if(!this.__relatedTarget)return null;this.__relatedTargetComposedPath||
(this.__relatedTargetComposedPath=H(this.__relatedTarget,!0));return Na(this.currentTarget||this.__previousCurrentTarget,this.__relatedTargetComposedPath)},stopPropagation:function(){Event.prototype.stopPropagation.call(this);this.B=!0},stopImmediatePropagation:function(){Event.prototype.stopImmediatePropagation.call(this);this.B=this.__immediatePropagationStopped=!0}});
function Va(a,b){b=void 0===b?a.target:b;a.__target=b;a.__relatedTarget=a.relatedTarget;if(v.c){b=Object.getPrototypeOf(a);if(!b.hasOwnProperty("__shady_patchedProto")){var c=Object.create(b);c.__shady_sourceProto=b;A(c,Za);b.__shady_patchedProto=c}a.__proto__=b.__shady_patchedProto}else A(a,Za)}var $a=Oa(Event),ab=Oa(CustomEvent),bb=Oa(MouseEvent);
function cb(){if(!Ga&&Object.getOwnPropertyDescriptor(Event.prototype,"isTrusted")){var a=function(){var b=new MouseEvent("click",{bubbles:!0,cancelable:!0,composed:!0});this.__shady_dispatchEvent(b)};Element.prototype.click?Element.prototype.click=a:HTMLElement.prototype.click&&(HTMLElement.prototype.click=a)}}
var db=Object.getOwnPropertyNames(Element.prototype).filter(function(a){return"on"===a.substring(0,2)}),eb=Object.getOwnPropertyNames(HTMLElement.prototype).filter(function(a){return"on"===a.substring(0,2)});function fb(a){return{set:function(b){var c=t(this),d=a.substring(2);c.h||(c.h={});c.h[a]&&this.removeEventListener(d,c.h[a]);this.__shady_addEventListener(d,b);c.h[a]=b},get:function(){var b=u(this);return b&&b.h&&b.h[a]},configurable:!0}};var gb=B({dispatchEvent:Ua,addEventListener:Wa,removeEventListener:Xa});var hb=window.document,ib=v.o,jb=Object.getOwnPropertyDescriptor(Node.prototype,"isConnected"),kb=jb&&jb.get;function lb(a){for(var b;b=a.__shady_firstChild;)a.__shady_removeChild(b)}function mb(a){var b=u(a);if(b&&void 0!==b.A)for(b=a.__shady_firstChild;b;b=b.__shady_nextSibling)mb(b);if(a=u(a))a.A=void 0}function nb(a){var b=a;if(a&&"slot"===a.localName){var c=u(a);(c=c&&c.l)&&(b=c.length?c[0]:nb(a.__shady_nextSibling))}return b}
function ob(a,b,c){if(a=(a=u(a))&&a.m){if(b)if(b.nodeType===Node.DOCUMENT_FRAGMENT_NODE)for(var d=0,e=b.childNodes.length;d<e;d++)a.addedNodes.push(b.childNodes[d]);else a.addedNodes.push(b);c&&a.removedNodes.push(c);pb(a)}}
var M=B({get parentNode(){var a=u(this);a=a&&a.parentNode;return void 0!==a?a:this.__shady_native_parentNode},get firstChild(){var a=u(this);a=a&&a.firstChild;return void 0!==a?a:this.__shady_native_firstChild},get lastChild(){var a=u(this);a=a&&a.lastChild;return void 0!==a?a:this.__shady_native_lastChild},get nextSibling(){var a=u(this);a=a&&a.nextSibling;return void 0!==a?a:this.__shady_native_nextSibling},get previousSibling(){var a=u(this);a=a&&a.previousSibling;return void 0!==a?a:this.__shady_native_previousSibling},
get childNodes(){if(w(this)){var a=u(this);if(!a.childNodes){a.childNodes=[];for(var b=this.__shady_firstChild;b;b=b.__shady_nextSibling)a.childNodes.push(b)}var c=a.childNodes}else c=this.__shady_native_childNodes;c.item=function(d){return c[d]};return c},get parentElement(){var a=u(this);(a=a&&a.parentNode)&&a.nodeType!==Node.ELEMENT_NODE&&(a=null);return void 0!==a?a:this.__shady_native_parentElement},get isConnected(){if(kb&&kb.call(this))return!0;if(this.nodeType==Node.DOCUMENT_FRAGMENT_NODE)return!1;
var a=this.ownerDocument;if(null===a||pa(a,this))return!0;for(a=this;a&&!(a instanceof Document);)a=a.__shady_parentNode||(x(a)?a.host:void 0);return!!(a&&a instanceof Document)},get textContent(){if(w(this)){for(var a=[],b=this.__shady_firstChild;b;b=b.__shady_nextSibling)b.nodeType!==Node.COMMENT_NODE&&a.push(b.__shady_textContent);return a.join("")}return this.__shady_native_textContent},set textContent(a){if("undefined"===typeof a||null===a)a="";switch(this.nodeType){case Node.ELEMENT_NODE:case Node.DOCUMENT_FRAGMENT_NODE:if(!w(this)&&
v.c){var b=this.__shady_firstChild;(b!=this.__shady_lastChild||b&&b.nodeType!=Node.TEXT_NODE)&&lb(this);this.__shady_native_textContent=a}else lb(this),(0<a.length||this.nodeType===Node.ELEMENT_NODE)&&this.__shady_insertBefore(document.createTextNode(a));break;default:this.nodeValue=a}},insertBefore:function(a,b){if(this.ownerDocument!==hb&&a.ownerDocument!==hb)return this.__shady_native_insertBefore(a,b),a;if(a===this)throw Error("Failed to execute 'appendChild' on 'Node': The new child element contains the parent.");
if(b){var c=u(b);c=c&&c.parentNode;if(void 0!==c&&c!==this||void 0===c&&b.__shady_native_parentNode!==this)throw Error("Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.");}if(b===a)return a;ob(this,a);var d=[],e=(c=I(this))?c.host.localName:J(this),f=a.__shady_parentNode;if(f){var g=J(a);var h=!!c||!I(a)||ib&&void 0!==this.__noInsertionPoint;f.__shady_removeChild(a,h)}f=!0;var m=(!ib||void 0===a.__noInsertionPoint&&void 0===
this.__noInsertionPoint)&&!qb(a,e),l=c&&!a.__noInsertionPoint&&(!ib||a.nodeType===Node.DOCUMENT_FRAGMENT_NODE);if(l||m)m&&(g=g||J(a)),rb(a,function(k){l&&"slot"===k.localName&&d.push(k);if(m){var r=g;K()&&(r&&sb(k,r),(r=K())&&r.scopeNode(k,e))}});d.length&&(tb(c),c.f.push.apply(c.f,p(d)),L(c));w(this)&&(ub(a,this,b),h=u(this),h.root?(f=!1,ia(this)&&L(h.root)):c&&"slot"===this.localName&&(f=!1,L(c)));f?(c=x(this)?this.host:this,b?(b=nb(b),c.__shady_native_insertBefore(a,b)):c.__shady_native_appendChild(a)):
a.ownerDocument!==this.ownerDocument&&this.ownerDocument.adoptNode(a);return a},appendChild:function(a){if(this!=a||!x(a))return this.__shady_insertBefore(a)},removeChild:function(a,b){b=void 0===b?!1:b;if(this.ownerDocument!==hb)return this.__shady_native_removeChild(a);if(a.__shady_parentNode!==this)throw Error("The node to be removed is not a child of this node: "+a);ob(this,null,a);var c=I(a),d=c&&vb(c,a),e=u(this);if(w(this)&&(wb(a,this),ia(this))){L(e.root);var f=!0}if(K()&&!b&&c&&a.nodeType!==
Node.TEXT_NODE){var g=J(a);rb(a,function(h){sb(h,g)})}mb(a);c&&((b="slot"===this.localName)&&(f=!0),(d||b)&&L(c));f||(f=x(this)?this.host:this,(!e.root&&"slot"!==a.localName||f===a.__shady_native_parentNode)&&f.__shady_native_removeChild(a));return a},replaceChild:function(a,b){this.__shady_insertBefore(a,b);this.__shady_removeChild(b);return a},cloneNode:function(a){if("template"==this.localName)return this.__shady_native_cloneNode(a);var b=this.__shady_native_cloneNode(!1);if(a&&b.nodeType!==Node.ATTRIBUTE_NODE){a=
this.__shady_firstChild;for(var c;a;a=a.__shady_nextSibling)c=a.__shady_cloneNode(!0),b.__shady_appendChild(c)}return b},getRootNode:function(a){if(this&&this.nodeType){var b=t(this),c=b.A;void 0===c&&(x(this)?(c=this,b.A=c):(c=(c=this.__shady_parentNode)?c.__shady_getRootNode(a):this,document.documentElement.__shady_native_contains(this)&&(b.A=c)));return c}},contains:function(a){return qa(this,a)}});var O=B({get assignedSlot(){var a=this.__shady_parentNode;(a=a&&a.__shady_shadowRoot)&&N(a);return(a=u(this))&&a.assignedSlot||null}});function xb(a,b,c){var d=[];yb(a,b,c,d);return d}function yb(a,b,c,d){for(a=a.__shady_firstChild;a;a=a.__shady_nextSibling){var e;if(e=a.nodeType===Node.ELEMENT_NODE){e=a;var f=b,g=c,h=d,m=f(e);m&&h.push(e);g&&g(m)?e=m:(yb(e,f,g,h),e=void 0)}if(e)break}}
var zb={get firstElementChild(){var a=u(this);if(a&&void 0!==a.firstChild){for(a=this.__shady_firstChild;a&&a.nodeType!==Node.ELEMENT_NODE;)a=a.__shady_nextSibling;return a}return this.__shady_native_firstElementChild},get lastElementChild(){var a=u(this);if(a&&void 0!==a.lastChild){for(a=this.__shady_lastChild;a&&a.nodeType!==Node.ELEMENT_NODE;)a=a.__shady_previousSibling;return a}return this.__shady_native_lastElementChild},get children(){return w(this)?z(Array.prototype.filter.call(sa(this),function(a){return a.nodeType===
Node.ELEMENT_NODE})):this.__shady_native_children},get childElementCount(){var a=this.__shady_children;return a?a.length:0}},P=B((zb.append=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];this.__shady_insertBefore(D.apply(null,p(b)),null)},zb.prepend=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];this.__shady_insertBefore(D.apply(null,p(b)),this.__shady_firstChild)},zb.replaceChildren=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];
for(;null!==(c=this.__shady_firstChild);)this.__shady_removeChild(c);this.__shady_insertBefore(D.apply(null,p(b)),null)},zb)),Ab=B({querySelector:function(a){return xb(this,function(b){return ka.call(b,a)},function(b){return!!b})[0]||null},querySelectorAll:function(a,b){if(b){b=Array.prototype.slice.call(this.__shady_native_querySelectorAll(a));var c=this.__shady_getRootNode();return z(b.filter(function(d){return d.__shady_getRootNode()==c}))}return z(xb(this,function(d){return ka.call(d,a)}))}}),
Bb=v.o&&!v.g?va({},P):P;va(P,Ab);/*

Copyright (c) 2020 The Polymer Project Authors. All rights reserved.
This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
Code distributed by Google as part of the polymer project is also
subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
*/
var Cb=B({after:function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];c=this.__shady_parentNode;if(null!==c){var d=this.__shady_nextSibling;c.__shady_insertBefore(D.apply(null,p(b)),d)}},before:function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];c=this.__shady_parentNode;null!==c&&c.__shady_insertBefore(D.apply(null,p(b)),this)},remove:function(){var a=this.__shady_parentNode;null!==a&&a.__shady_removeChild(this)},replaceWith:function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=
arguments[c];c=this.__shady_parentNode;if(null!==c){var d=this.__shady_nextSibling;c.__shady_removeChild(this);c.__shady_insertBefore(D.apply(null,p(b)),d)}}});var Db=null;function K(){Db||(Db=window.ShadyCSS&&window.ShadyCSS.ScopingShim);return Db||null}function Eb(a,b,c){var d=K();return d&&"class"===b?(d.setElementClass(a,c),!0):!1}function sb(a,b){var c=K();c&&c.unscopeNode(a,b)}function qb(a,b){var c=K();if(!c)return!0;if(a.nodeType===Node.DOCUMENT_FRAGMENT_NODE){c=!0;for(a=a.__shady_firstChild;a;a=a.__shady_nextSibling)c=c&&qb(a,b);return c}return a.nodeType!==Node.ELEMENT_NODE?!0:c.currentScopeForNode(a)===b}
function J(a){if(a.nodeType!==Node.ELEMENT_NODE)return"";var b=K();return b?b.currentScopeForNode(a):""}function rb(a,b){if(a)for(a.nodeType===Node.ELEMENT_NODE&&b(a),a=a.__shady_firstChild;a;a=a.__shady_nextSibling)a.nodeType===Node.ELEMENT_NODE&&rb(a,b)};var Fb=window.document;function Gb(a,b){if("slot"===b)a=a.__shady_parentNode,ia(a)&&L(u(a).root);else if("slot"===a.localName&&"name"===b&&(b=I(a))){if(b.a){Hb(b);var c=a.O,d=Ib(a);if(d!==c){c=b.b[c];var e=c.indexOf(a);0<=e&&c.splice(e,1);c=b.b[d]||(b.b[d]=[]);c.push(a);1<c.length&&(b.b[d]=Jb(c))}}L(b)}}
var Kb=B({get previousElementSibling(){var a=u(this);if(a&&void 0!==a.previousSibling){for(a=this.__shady_previousSibling;a&&a.nodeType!==Node.ELEMENT_NODE;)a=a.__shady_previousSibling;return a}return this.__shady_native_previousElementSibling},get nextElementSibling(){var a=u(this);if(a&&void 0!==a.nextSibling){for(a=this.__shady_nextSibling;a&&a.nodeType!==Node.ELEMENT_NODE;)a=a.__shady_nextSibling;return a}return this.__shady_native_nextElementSibling},get slot(){return this.getAttribute("slot")},
set slot(a){this.__shady_setAttribute("slot",a)},get className(){return this.getAttribute("class")||""},set className(a){this.__shady_setAttribute("class",a)},setAttribute:function(a,b){this.ownerDocument!==Fb?this.__shady_native_setAttribute(a,b):Eb(this,a,b)||(this.__shady_native_setAttribute(a,b),Gb(this,a))},removeAttribute:function(a){this.ownerDocument!==Fb?this.__shady_native_removeAttribute(a):Eb(this,a,"")?""===this.getAttribute(a)&&this.__shady_native_removeAttribute(a):(this.__shady_native_removeAttribute(a),
Gb(this,a))}});v.o||db.forEach(function(a){Kb[a]=fb(a)});
var Pb=B({attachShadow:function(a){if(!this)throw Error("Must provide a host.");if(!a)throw Error("Not enough arguments.");if(a.shadyUpgradeFragment&&!v.L){var b=a.shadyUpgradeFragment;b.__proto__=ShadowRoot.prototype;Lb(b,this,a);Mb(b,b);a=b.__noInsertionPoint?null:b.querySelectorAll("slot");b.__noInsertionPoint=void 0;if(a&&a.length){var c=b;tb(c);c.f.push.apply(c.f,p(a));L(b)}b.host.__shady_native_appendChild(b)}else b=new Nb(Ob,this,a);return this.__CE_shadowRoot=b},get shadowRoot(){var a=u(this);
return a&&a.U||null}});va(Kb,Pb);var Qb=/[&\u00A0"]/g,Rb=/[&\u00A0<>]/g;function Sb(a){switch(a){case "&":return"&amp;";case "<":return"&lt;";case ">":return"&gt;";case '"':return"&quot;";case "\u00a0":return"&nbsp;"}}function Tb(a){for(var b={},c=0;c<a.length;c++)b[a[c]]=!0;return b}var Ub=Tb("area base br col command embed hr img input keygen link meta param source track wbr".split(" ")),Vb=Tb("style script xmp iframe noembed noframes plaintext noscript".split(" "));
function Wb(a,b){"template"===a.localName&&(a=a.content);for(var c="",d=b?b(a):a.childNodes,e=0,f=d.length,g=void 0;e<f&&(g=d[e]);e++){a:{var h=g;var m=a,l=b;switch(h.nodeType){case Node.ELEMENT_NODE:m=h.localName;for(var k="<"+m,r=h.attributes,C=0,R;R=r[C];C++)k+=" "+R.name+'="'+R.value.replace(Qb,Sb)+'"';k+=">";h=Ub[m]?k:k+Wb(h,l)+"</"+m+">";break a;case Node.TEXT_NODE:h=h.data;h=m&&Vb[m.localName]?h:h.replace(Rb,Sb);break a;case Node.COMMENT_NODE:h="\x3c!--"+h.data+"--\x3e";break a;default:throw window.console.error(h),
Error("not implemented");}}c+=h}return c};var Xb=document.implementation.createHTMLDocument("inert"),Yb=B({get innerHTML(){return w(this)?Wb("template"===this.localName?this.content:this,sa):this.__shady_native_innerHTML},set innerHTML(a){if("template"===this.localName)this.__shady_native_innerHTML=a;else{lb(this);var b=this.localName||"div";b=this.namespaceURI&&this.namespaceURI!==Xb.namespaceURI?Xb.createElementNS(this.namespaceURI,b):Xb.createElement(b);for(v.c?b.__shady_native_innerHTML=a:b.innerHTML=a;a=b.__shady_firstChild;)this.__shady_insertBefore(a)}}});var Zb=B({blur:function(){var a=u(this);(a=(a=a&&a.root)&&a.activeElement)?a.__shady_blur():this.__shady_native_blur()}});v.o||eb.forEach(function(a){Zb[a]=fb(a)});var $b=B({assignedNodes:function(a){if("slot"===this.localName){var b=this.__shady_getRootNode();b&&x(b)&&N(b);return(b=u(this))?(a&&a.flatten?b.l:b.assignedNodes)||[]:[]}},addEventListener:function(a,b,c){if("slot"!==this.localName||"slotchange"===a)Wa.call(this,a,b,c);else{"object"!==typeof c&&(c={capture:!!c});var d=this.__shady_parentNode;if(!d)throw Error("ShadyDOM cannot attach event to slot unless it has a parentNode");c.i=this;d.__shady_addEventListener(a,b,c)}},removeEventListener:function(a,
b,c){if("slot"!==this.localName||"slotchange"===a)Xa.call(this,a,b,c);else{"object"!==typeof c&&(c={capture:!!c});var d=this.__shady_parentNode;if(!d)throw Error("ShadyDOM cannot attach event to slot unless it has a parentNode");c.i=this;d.__shady_removeEventListener(a,b,c)}}});var ac=B({getElementById:function(a){return""===a?null:xb(this,function(b){return b.id==a},function(b){return!!b})[0]||null}});var bc=B({get activeElement(){var a=v.c?document.__shady_native_activeElement:document.activeElement;if(!a||!a.nodeType)return null;var b=!!x(this);if(!(this===document||b&&this.host!==a&&this.host.__shady_native_contains(a)))return null;for(b=I(a);b&&b!==this;)a=b.host,b=I(a);return this===document?b?null:a:b===this?a:null}});var cc=window.document,dc=B({importNode:function(a,b){if(a.ownerDocument!==cc||"template"===a.localName)return this.__shady_native_importNode(a,b);var c=this.__shady_native_importNode(a,!1);if(b)for(a=a.__shady_firstChild;a;a=a.__shady_nextSibling)b=this.__shady_importNode(a,!0),c.__shady_appendChild(b);return c}});var ec=B({dispatchEvent:Ua,addEventListener:Wa.bind(window),removeEventListener:Xa.bind(window)});var Q={};Object.getOwnPropertyDescriptor(HTMLElement.prototype,"parentElement")&&(Q.parentElement=M.parentElement);Object.getOwnPropertyDescriptor(HTMLElement.prototype,"contains")&&(Q.contains=M.contains);Object.getOwnPropertyDescriptor(HTMLElement.prototype,"children")&&(Q.children=P.children);Object.getOwnPropertyDescriptor(HTMLElement.prototype,"innerHTML")&&(Q.innerHTML=Yb.innerHTML);Object.getOwnPropertyDescriptor(HTMLElement.prototype,"className")&&(Q.className=Kb.className);
var S={EventTarget:[gb],Node:[M,window.EventTarget?null:gb],Text:[O],Comment:[O],CDATASection:[O],ProcessingInstruction:[O],Element:[Kb,P,Cb,O,!v.c||"innerHTML"in Element.prototype?Yb:null,window.HTMLSlotElement?null:$b],HTMLElement:[Zb,Q],HTMLSlotElement:[$b],DocumentFragment:[Bb,ac],Document:[dc,Bb,ac,bc],Window:[ec],CharacterData:[Cb]},fc=v.c?null:["innerHTML","textContent"];function T(a,b,c,d){b.forEach(function(e){return a&&e&&A(a,e,c,d)})}
function gc(a){var b=a?null:fc,c;for(c in S)T(window[c]&&window[c].prototype,S[c],a,b)}["Text","Comment","CDATASection","ProcessingInstruction"].forEach(function(a){var b=window[a],c=Object.create(b.prototype);c.__shady_protoIsPatched=!0;T(c,S.EventTarget);T(c,S.Node);S[a]&&T(c,S[a]);b.prototype.__shady_patchedProto=c});function hc(a){a.__shady_protoIsPatched=!0;T(a,S.EventTarget);T(a,S.Node);T(a,S.Element);T(a,S.HTMLElement);T(a,S.HTMLSlotElement);return a};var ic=v.G,jc=v.c;function kc(a,b){if(ic&&!a.__shady_protoIsPatched&&!x(a)){var c=Object.getPrototypeOf(a),d=c.hasOwnProperty("__shady_patchedProto")&&c.__shady_patchedProto;d||(d=Object.create(c),hc(d),c.__shady_patchedProto=d);Object.setPrototypeOf(a,d)}jc||(1===b?Ea(a):2===b&&Fa(a))}
function lc(a,b,c,d){kc(a,1);d=d||null;var e=t(a),f=d?t(d):null;e.previousSibling=d?f.previousSibling:b.__shady_lastChild;if(f=u(e.previousSibling))f.nextSibling=a;if(f=u(e.nextSibling=d))f.previousSibling=a;e.parentNode=b;d?d===c.firstChild&&(c.firstChild=a):(c.lastChild=a,c.firstChild||(c.firstChild=a));c.childNodes=null}
function ub(a,b,c){kc(b,2);var d=t(b);void 0!==d.firstChild&&(d.childNodes=null);if(a.nodeType===Node.DOCUMENT_FRAGMENT_NODE)for(a=a.__shady_native_firstChild;a;a=a.__shady_native_nextSibling)lc(a,b,d,c);else lc(a,b,d,c)}
function wb(a,b){var c=t(a);b=t(b);a===b.firstChild&&(b.firstChild=c.nextSibling);a===b.lastChild&&(b.lastChild=c.previousSibling);a=c.previousSibling;var d=c.nextSibling;a&&(t(a).nextSibling=d);d&&(t(d).previousSibling=a);c.parentNode=c.previousSibling=c.nextSibling=void 0;void 0!==b.childNodes&&(b.childNodes=null)}
function Mb(a,b){var c=t(a);if(b||void 0===c.firstChild){c.childNodes=null;var d=c.firstChild=a.__shady_native_firstChild;c.lastChild=a.__shady_native_lastChild;kc(a,2);c=d;for(d=void 0;c;c=c.__shady_native_nextSibling){var e=t(c);e.parentNode=b||a;e.nextSibling=c.__shady_native_nextSibling;e.previousSibling=d||null;d=c;kc(c,1)}}};var mc=B({addEventListener:function(a,b,c){"object"!==typeof c&&(c={capture:!!c});c.i=c.i||this;this.host.__shady_addEventListener(a,b,c)},removeEventListener:function(a,b,c){"object"!==typeof c&&(c={capture:!!c});c.i=c.i||this;this.host.__shady_removeEventListener(a,b,c)}});function nc(a,b){A(a,mc,b);A(a,bc,b);A(a,Yb,b);A(a,P,b);v.g&&!b?(A(a,M,b),A(a,ac,b)):v.c||(A(a,Ba),A(a,za),A(a,Aa))};var Ob={},U=v.deferConnectionCallbacks&&"loading"===document.readyState,oc;function pc(a){var b=[];do b.unshift(a);while(a=a.__shady_parentNode);return b}function Nb(a,b,c){if(a!==Ob)throw new TypeError("Illegal constructor");this.a=null;Lb(this,b,c)}
function Lb(a,b,c){a.host=b;a.mode=c&&c.mode;Mb(a.host);b=t(a.host);b.root=a;b.U="closed"!==a.mode?a:null;b=t(a);b.firstChild=b.lastChild=b.parentNode=b.nextSibling=b.previousSibling=null;if(v.preferPerformance)for(;b=a.host.__shady_native_firstChild;)a.host.__shady_native_removeChild(b);else L(a)}function L(a){a.j||(a.j=!0,ya(function(){return N(a)}))}
function N(a){var b;if(b=a.j){for(var c;a;)a:{a.j&&(c=a),b=a;a=b.host.__shady_getRootNode();if(x(a)&&(b=u(b.host))&&0<b.u)break a;a=void 0}b=c}(c=b)&&c._renderSelf()}
Nb.prototype._renderSelf=function(){var a=U;U=!0;this.j=!1;if(this.a){Hb(this);for(var b=0,c;b<this.a.length;b++){c=this.a[b];var d=u(c),e=d.assignedNodes;d.assignedNodes=[];d.l=[];if(d.I=e)for(d=0;d<e.length;d++){var f=u(e[d]);f.C=f.assignedSlot;f.assignedSlot===c&&(f.assignedSlot=null)}}for(b=this.host.__shady_firstChild;b;b=b.__shady_nextSibling)qc(this,b);for(b=0;b<this.a.length;b++){c=this.a[b];e=u(c);if(!e.assignedNodes.length)for(d=c.__shady_firstChild;d;d=d.__shady_nextSibling)qc(this,d,c);
(d=(d=u(c.__shady_parentNode))&&d.root)&&(ja(d)||d.j)&&d._renderSelf();rc(this,e.l,e.assignedNodes);if(d=e.I){for(f=0;f<d.length;f++)u(d[f]).C=null;e.I=null;d.length>e.assignedNodes.length&&(e.D=!0)}e.D&&(e.D=!1,sc(this,c))}c=this.a;b=[];for(e=0;e<c.length;e++)d=c[e].__shady_parentNode,(f=u(d))&&f.root||!(0>b.indexOf(d))||b.push(d);for(c=0;c<b.length;c++){f=b[c];e=f===this?this.host:f;d=[];for(f=f.__shady_firstChild;f;f=f.__shady_nextSibling)if("slot"==f.localName)for(var g=u(f).l,h=0;h<g.length;h++)d.push(g[h]);
else d.push(f);f=ra(e);g=da(d,d.length,f,f.length);for(var m=h=0,l=void 0;h<g.length&&(l=g[h]);h++){for(var k=0,r=void 0;k<l.s.length&&(r=l.s[k]);k++)r.__shady_native_parentNode===e&&e.__shady_native_removeChild(r),f.splice(l.index+m,1);m-=l.v}m=0;for(l=void 0;m<g.length&&(l=g[m]);m++)for(h=f[l.index],k=l.index;k<l.index+l.v;k++)r=d[k],e.__shady_native_insertBefore(r,h),f.splice(k,0,r)}}if(!v.preferPerformance&&!this.H)for(b=this.host.__shady_firstChild;b;b=b.__shady_nextSibling)c=u(b),b.__shady_native_parentNode!==
this.host||"slot"!==b.localName&&c.assignedSlot||this.host.__shady_native_removeChild(b);this.H=!0;U=a;oc&&oc()};function qc(a,b,c){var d=t(b),e=d.C;d.C=null;c||(c=(a=a.b[b.__shady_slot||"__catchall"])&&a[0]);c?(t(c).assignedNodes.push(b),d.assignedSlot=c):d.assignedSlot=void 0;e!==d.assignedSlot&&d.assignedSlot&&(t(d.assignedSlot).D=!0)}function rc(a,b,c){for(var d=0,e=void 0;d<c.length&&(e=c[d]);d++)if("slot"==e.localName){var f=u(e).assignedNodes;f&&f.length&&rc(a,b,f)}else b.push(c[d])}
function sc(a,b){b.__shady_native_dispatchEvent(new Event("slotchange"));b=u(b);b.assignedSlot&&sc(a,b.assignedSlot)}function tb(a){a.f=a.f||[];a.a=a.a||[];a.b=a.b||{}}function Hb(a){if(a.f&&a.f.length){for(var b=a.f,c,d=0;d<b.length;d++){var e=b[d];Mb(e);var f=e.__shady_parentNode;Mb(f);f=u(f);f.u=(f.u||0)+1;f=Ib(e);a.b[f]?(c=c||{},c[f]=!0,a.b[f].push(e)):a.b[f]=[e];a.a.push(e)}if(c)for(var g in c)a.b[g]=Jb(a.b[g]);a.f=[]}}
function Ib(a){var b=a.name||a.getAttribute("name")||"__catchall";return a.O=b}function Jb(a){return a.sort(function(b,c){b=pc(b);for(var d=pc(c),e=0;e<b.length;e++){c=b[e];var f=d[e];if(c!==f)return b=sa(c.__shady_parentNode),b.indexOf(c)-b.indexOf(f)}})}
function vb(a,b){if(a.a){Hb(a);var c=a.b,d;for(d in c)for(var e=c[d],f=0;f<e.length;f++){var g=e[f];if(qa(b,g)){e.splice(f,1);var h=a.a.indexOf(g);0<=h&&(a.a.splice(h,1),(h=u(g.__shady_parentNode))&&h.u&&h.u--);f--;g=u(g);if(h=g.l)for(var m=0;m<h.length;m++){var l=h[m],k=l.__shady_native_parentNode;k&&k.__shady_native_removeChild(l)}g.l=[];g.assignedNodes=[];h=!0}}return h}}function ja(a){Hb(a);return!(!a.a||!a.a.length)}
(function(a){a.__proto__=DocumentFragment.prototype;nc(a,"__shady_");nc(a);Object.defineProperties(a,{nodeType:{value:Node.DOCUMENT_FRAGMENT_NODE,configurable:!0},nodeName:{value:"#document-fragment",configurable:!0},nodeValue:{value:null,configurable:!0}});["localName","namespaceURI","prefix"].forEach(function(b){Object.defineProperty(a,b,{value:void 0,configurable:!0})});["ownerDocument","baseURI","isConnected"].forEach(function(b){Object.defineProperty(a,b,{get:function(){return this.host[b]},
configurable:!0})})})(Nb.prototype);
if(window.customElements&&window.customElements.define&&v.F&&!v.preferPerformance){var tc=new Map;oc=function(){var a=[];tc.forEach(function(d,e){a.push([e,d])});tc.clear();for(var b=0;b<a.length;b++){var c=a[b][0];a[b][1]?c.__shadydom_connectedCallback():c.__shadydom_disconnectedCallback()}};U&&document.addEventListener("readystatechange",function(){U=!1;oc()},{once:!0});var uc=function(a,b,c){var d=0,e="__isConnected"+d++;if(b||c)a.prototype.connectedCallback=a.prototype.__shadydom_connectedCallback=
function(){U?tc.set(this,!0):this[e]||(this[e]=!0,b&&b.call(this))},a.prototype.disconnectedCallback=a.prototype.__shadydom_disconnectedCallback=function(){U?this.isConnected||tc.set(this,!1):this[e]&&(this[e]=!1,c&&c.call(this))};return a},vc=window.customElements.define,wc=function(a,b){var c=b.prototype.connectedCallback,d=b.prototype.disconnectedCallback;vc.call(window.customElements,a,uc(b,c,d));b.prototype.connectedCallback=c;b.prototype.disconnectedCallback=d};window.customElements.define=
wc;Object.defineProperty(window.CustomElementRegistry.prototype,"define",{value:wc,configurable:!0})}function I(a){a=a.__shady_getRootNode();if(x(a))return a};function xc(){this.a=!1;this.addedNodes=[];this.removedNodes=[];this.w=new Set}function pb(a){a.a||(a.a=!0,oa(function(){a.flush()}))}xc.prototype.flush=function(){if(this.a){this.a=!1;var a=this.takeRecords();a.length&&this.w.forEach(function(b){b(a)})}};xc.prototype.takeRecords=function(){if(this.addedNodes.length||this.removedNodes.length){var a=[{addedNodes:this.addedNodes,removedNodes:this.removedNodes}];this.addedNodes=[];this.removedNodes=[];return a}return[]};
function yc(a,b){var c=t(a);c.m||(c.m=new xc);c.m.w.add(b);var d=c.m;return{P:b,S:d,R:a,takeRecords:function(){return d.takeRecords()}}}function zc(a){var b=a&&a.S;b&&(b.w.delete(a.P),b.w.size||(t(a.R).m=null))}
function Ac(a,b){var c=b.getRootNode();return a.map(function(d){var e=c===d.target.getRootNode();if(e&&d.addedNodes){if(e=[].slice.call(d.addedNodes).filter(function(f){return c===f.getRootNode()}),e.length)return d=Object.create(d),Object.defineProperty(d,"addedNodes",{value:e,configurable:!0}),d}else if(e)return d}).filter(function(d){return d})};var Bc=v.c,Cc={querySelector:function(a){return this.__shady_native_querySelector(a)},querySelectorAll:function(a){return this.__shady_native_querySelectorAll(a)}},Dc={};function Ec(a){Dc[a]=function(b){return b["__shady_native_"+a]}}function V(a,b){A(a,b,"__shady_native_");for(var c in b)Ec(c)}function W(a,b){b=void 0===b?[]:b;for(var c=0;c<b.length;c++){var d=b[c],e=Object.getOwnPropertyDescriptor(a,d);e&&(Object.defineProperty(a,"__shady_native_"+d,e),e.value?Cc[d]||(Cc[d]=e.value):Ec(d))}}
var X=document.createTreeWalker(document,NodeFilter.SHOW_ALL,null,!1),Y=document.createTreeWalker(document,NodeFilter.SHOW_ELEMENT,null,!1),Fc=document.implementation.createHTMLDocument("inert");function Gc(a){for(var b;b=a.__shady_native_firstChild;)a.__shady_native_removeChild(b)}var Hc=["firstElementChild","lastElementChild","children","childElementCount"],Ic=["querySelector","querySelectorAll","append","prepend","replaceChildren"];
function Jc(){var a=["dispatchEvent","addEventListener","removeEventListener"];window.EventTarget?W(window.EventTarget.prototype,a):(W(Node.prototype,a),W(Window.prototype,a));Bc?W(Node.prototype,"parentNode firstChild lastChild previousSibling nextSibling childNodes parentElement textContent".split(" ")):V(Node.prototype,{parentNode:{get:function(){X.currentNode=this;return X.parentNode()}},firstChild:{get:function(){X.currentNode=this;return X.firstChild()}},lastChild:{get:function(){X.currentNode=
this;return X.lastChild()}},previousSibling:{get:function(){X.currentNode=this;return X.previousSibling()}},nextSibling:{get:function(){X.currentNode=this;return X.nextSibling()}},childNodes:{get:function(){var b=[];X.currentNode=this;for(var c=X.firstChild();c;)b.push(c),c=X.nextSibling();return b}},parentElement:{get:function(){Y.currentNode=this;return Y.parentNode()}},textContent:{get:function(){switch(this.nodeType){case Node.ELEMENT_NODE:case Node.DOCUMENT_FRAGMENT_NODE:for(var b=document.createTreeWalker(this,
NodeFilter.SHOW_TEXT,null,!1),c="",d;d=b.nextNode();)c+=d.nodeValue;return c;default:return this.nodeValue}},set:function(b){if("undefined"===typeof b||null===b)b="";switch(this.nodeType){case Node.ELEMENT_NODE:case Node.DOCUMENT_FRAGMENT_NODE:Gc(this);(0<b.length||this.nodeType===Node.ELEMENT_NODE)&&this.__shady_native_insertBefore(document.createTextNode(b),void 0);break;default:this.nodeValue=b}}}});W(Node.prototype,"appendChild insertBefore removeChild replaceChild cloneNode contains".split(" "));
W(HTMLElement.prototype,["parentElement","contains"]);a={firstElementChild:{get:function(){Y.currentNode=this;return Y.firstChild()}},lastElementChild:{get:function(){Y.currentNode=this;return Y.lastChild()}},children:{get:function(){var b=[];Y.currentNode=this;for(var c=Y.firstChild();c;)b.push(c),c=Y.nextSibling();return z(b)}},childElementCount:{get:function(){return this.children?this.children.length:0}}};Bc?(W(Element.prototype,Hc),W(Element.prototype,["previousElementSibling","nextElementSibling",
"innerHTML","className"]),W(HTMLElement.prototype,["children","innerHTML","className"])):(V(Element.prototype,a),V(Element.prototype,{previousElementSibling:{get:function(){Y.currentNode=this;return Y.previousSibling()}},nextElementSibling:{get:function(){Y.currentNode=this;return Y.nextSibling()}},innerHTML:{get:function(){return Wb(this,ra)},set:function(b){var c="template"===this.localName?this.content:this;Gc(c);var d=this.localName||"div";d=this.namespaceURI&&this.namespaceURI!==Fc.namespaceURI?
Fc.createElementNS(this.namespaceURI,d):Fc.createElement(d);d.innerHTML=b;for(b="template"===this.localName?d.content:d;d=b.__shady_native_firstChild;)c.__shady_native_insertBefore(d,void 0)}},className:{get:function(){return this.getAttribute("class")||""},set:function(b){this.setAttribute("class",b)}}}));W(Element.prototype,"setAttribute getAttribute hasAttribute removeAttribute focus blur".split(" "));W(Element.prototype,Ic);W(HTMLElement.prototype,["focus","blur"]);window.HTMLTemplateElement&&
W(window.HTMLTemplateElement.prototype,["innerHTML"]);Bc?W(DocumentFragment.prototype,Hc):V(DocumentFragment.prototype,a);W(DocumentFragment.prototype,Ic);Bc?(W(Document.prototype,Hc),W(Document.prototype,["activeElement"])):V(Document.prototype,a);W(Document.prototype,["importNode","getElementById"]);W(Document.prototype,Ic)};function Z(a){this.node=a}n=Z.prototype;n.addEventListener=function(a,b,c){return this.node.__shady_addEventListener(a,b,c)};n.removeEventListener=function(a,b,c){return this.node.__shady_removeEventListener(a,b,c)};n.appendChild=function(a){return this.node.__shady_appendChild(a)};n.insertBefore=function(a,b){return this.node.__shady_insertBefore(a,b)};n.removeChild=function(a){return this.node.__shady_removeChild(a)};n.replaceChild=function(a,b){return this.node.__shady_replaceChild(a,b)};
n.cloneNode=function(a){return this.node.__shady_cloneNode(a)};n.getRootNode=function(a){return this.node.__shady_getRootNode(a)};n.contains=function(a){return this.node.__shady_contains(a)};n.dispatchEvent=function(a){return this.node.__shady_dispatchEvent(a)};n.setAttribute=function(a,b){this.node.__shady_setAttribute(a,b)};n.getAttribute=function(a){return this.node.__shady_native_getAttribute(a)};n.removeAttribute=function(a){this.node.__shady_removeAttribute(a)};n.attachShadow=function(a){return this.node.__shady_attachShadow(a)};
n.focus=function(){this.node.__shady_native_focus()};n.blur=function(){this.node.__shady_blur()};n.importNode=function(a,b){if(this.node.nodeType===Node.DOCUMENT_NODE)return this.node.__shady_importNode(a,b)};n.getElementById=function(a){if(this.node.nodeType===Node.DOCUMENT_NODE)return this.node.__shady_getElementById(a)};n.querySelector=function(a){return this.node.__shady_querySelector(a)};n.querySelectorAll=function(a,b){return this.node.__shady_querySelectorAll(a,b)};
n.assignedNodes=function(a){if("slot"===this.node.localName)return this.node.__shady_assignedNodes(a)};n.append=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];return this.node.__shady_append.apply(this.node,p(b))};n.prepend=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];return this.node.__shady_prepend.apply(this.node,p(b))};n.after=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];return this.node.__shady_after.apply(this.node,p(b))};
n.before=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];return this.node.__shady_before.apply(this.node,p(b))};n.remove=function(){return this.node.__shady_remove()};n.replaceWith=function(a){for(var b=[],c=0;c<arguments.length;++c)b[c]=arguments[c];return this.node.__shady_replaceWith.apply(this.node,p(b))};
ca.Object.defineProperties(Z.prototype,{activeElement:{configurable:!0,enumerable:!0,get:function(){if(x(this.node)||this.node.nodeType===Node.DOCUMENT_NODE)return this.node.__shady_activeElement}},_activeElement:{configurable:!0,enumerable:!0,get:function(){return this.activeElement}},host:{configurable:!0,enumerable:!0,get:function(){if(x(this.node))return this.node.host}},parentNode:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_parentNode}},firstChild:{configurable:!0,
enumerable:!0,get:function(){return this.node.__shady_firstChild}},lastChild:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_lastChild}},nextSibling:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_nextSibling}},previousSibling:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_previousSibling}},childNodes:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_childNodes}},parentElement:{configurable:!0,enumerable:!0,
get:function(){return this.node.__shady_parentElement}},firstElementChild:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_firstElementChild}},lastElementChild:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_lastElementChild}},nextElementSibling:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_nextElementSibling}},previousElementSibling:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_previousElementSibling}},
children:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_children}},childElementCount:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_childElementCount}},shadowRoot:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_shadowRoot}},assignedSlot:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_assignedSlot}},isConnected:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_isConnected}},innerHTML:{configurable:!0,
enumerable:!0,get:function(){return this.node.__shady_innerHTML},set:function(a){this.node.__shady_innerHTML=a}},textContent:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_textContent},set:function(a){this.node.__shady_textContent=a}},slot:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_slot},set:function(a){this.node.__shady_slot=a}},className:{configurable:!0,enumerable:!0,get:function(){return this.node.__shady_className},set:function(a){return this.node.__shady_className=
a}}});function Kc(a){Object.defineProperty(Z.prototype,a,{get:function(){return this.node["__shady_"+a]},set:function(b){this.node["__shady_"+a]=b},configurable:!0})}db.forEach(function(a){return Kc(a)});eb.forEach(function(a){return Kc(a)});var Lc=new WeakMap;function Mc(a){if(x(a)||a instanceof Z)return a;var b=Lc.get(a);b||(b=new Z(a),Lc.set(a,b));return b};if(v.F){var Nc=v.c?function(a){return a}:function(a){Fa(a);Ea(a);return a};window.ShadyDOM={inUse:v.F,patch:Nc,isShadyRoot:x,enqueue:ya,flush:F,flushInitial:function(a){!a.H&&a.j&&N(a)},settings:v,filterMutations:Ac,observeChildren:yc,unobserveChildren:zc,deferConnectionCallbacks:v.deferConnectionCallbacks,preferPerformance:v.preferPerformance,handlesDynamicScoping:!0,wrap:v.g?Mc:Nc,wrapIfNeeded:!0===v.g?Mc:function(a){return a},Wrapper:Z,composedPath:Ma,noPatch:v.g,patchOnDemand:v.G,nativeMethods:Cc,
nativeTree:Dc,patchElementProto:hc};Jc();gc("__shady_");Object.defineProperty(document,"_activeElement",bc.activeElement);A(Window.prototype,ec,"__shady_");v.g?v.G&&A(Element.prototype,Pb):(gc(),cb());Ya();window.Event=$a;window.CustomEvent=ab;window.MouseEvent=bb;window.ShadowRoot=Nb};}).call(this);

//# sourceMappingURL=shadydom.min.js.map`,
  });
}

chrome.checkIfPageIsDoneLoading = function(tab) {
	return new Promise((resolve, reject) => {

		if (!(tab.prerender.domContentEventFired || tab.prerender.receivedRedirect)) {
			return resolve(false);
		}

		tab.Runtime.evaluate({
			expression: 'window.prerenderReady'
		}).then((result) => {
			let prerenderReady = result && result.result && result.result.value;
			let shouldWaitForPrerenderReady = typeof prerenderReady == 'boolean';
			let waitAfterLastRequest = tab.prerender.waitAfterLastRequest || this.options.waitAfterLastRequest;

			let doneLoading = tab.prerender.numRequestsInFlight <= 0 &&
				tab.prerender.lastRequestReceivedAt < ((new Date()).getTime() - waitAfterLastRequest)

			resolve((!shouldWaitForPrerenderReady && doneLoading) || (shouldWaitForPrerenderReady && doneLoading && prerenderReady));
		}).catch((err) => {
			util.log('unable to evaluate javascript on the page');
			tab.prerender.statusCode = 504;
			reject();
		});
	});

};



chrome.executeJavascript = function(tab, javascript) {
	return new Promise((resolve, reject) => {
		tab.Runtime.evaluate({
			expression: javascript
		}).then((result) => {

			//give previous javascript a little time to execute
			setTimeout( () => {

				tab.Runtime.evaluate({
					expression: "(window.prerenderData && typeof window.prerenderData == 'object' && JSON.stringify(window.prerenderData)) || window.prerenderData"
				}).then((result) => {
					try {
						tab.prerender.prerenderData = JSON.parse(result && result.result && result.result.value);
					} catch(e) {
						tab.prerender.prerenderData = result.result.value;
					}
					resolve();
				}).catch((err) => {
					util.log('unable to evaluate javascript on the page', err);
					tab.prerender.statusCode = 504;
					reject();
				});

			}, 1000);
		}).catch((err) => {
			util.log('unable to evaluate javascript on the page');
			tab.prerender.statusCode = 504;
			reject();
		});
	});
};



chrome.parseHtmlFromPage = function(tab) {
	return new Promise((resolve, reject) => {

		var parseTimeout = setTimeout(() => {
			util.log('parse html timed out', tab.prerender.url);
			tab.prerender.statusCode = 504;
			reject();
		}, 5000);

		tab.Runtime.evaluate({
			expression: "document.firstElementChild.outerHTML"
		}).then((resp) => {

			tab.prerender.content = resp.result.value;
			return tab.Runtime.evaluate({
				expression: 'document.doctype && JSON.stringify({name: document.doctype.name, systemId: document.doctype.systemId, publicId: document.doctype.publicId})'
			});
		}).then((response) => {

			let doctype = '';
			if (response && response.result && response.result.value) {
				let obj = {name: 'html'};
				try {
					obj = JSON.parse(response.result.value);
				} catch(e) {}

				doctype = "<!DOCTYPE "
					+ obj.name
					+ (obj.publicId ? ' PUBLIC "' + obj.publicId + '"' : '')
					+ (!obj.publicId && obj.systemId ? ' SYSTEM' : '')
					+ (obj.systemId ? ' "' + obj.systemId + '"' : '')
					+ '>'
			}

			tab.prerender.content = doctype + tab.prerender.content;
			clearTimeout(parseTimeout);
			resolve();
		}).catch((err) => {
			util.log('unable to parse HTML', err);
			tab.prerender.statusCode = 504;
			clearTimeout(parseTimeout);
			reject();
		});
	});
};


chrome.captureScreenshot = function(tab, format, fullpage) {
	return new Promise((resolve, reject) => {

		var parseTimeout = setTimeout(() => {
			util.log('capture screenshot timed out for', tab.prerender.url);
			tab.prerender.statusCode = 504;
			reject();
		}, 10000);

		tab.Page.getLayoutMetrics().then((viewports) => {

			let viewportClip = {
				x: 0,
				y: 0,
				width: viewports.visualViewport.clientWidth,
				height: viewports.visualViewport.clientHeight,
				scale: viewports.visualViewport.scale || 1
			};

			if (fullpage) {
				viewportClip.width = viewports.contentSize.width;
				viewportClip.height = viewports.contentSize.height;
			}

			tab.Page.captureScreenshot({
				format: format,
				clip: viewportClip
			}).then((response) => {
				tab.prerender.content = new Buffer(response.data, 'base64');
				clearTimeout(parseTimeout);
				resolve();
			}).catch((err) => {
				util.log('unable to capture screenshot:', err);
				tab.prerender.statusCode = 504;
				clearTimeout(parseTimeout);
				reject();
			});
		});

	});
};


chrome.printToPDF = function(tab, options) {
	return new Promise((resolve, reject) => {

		var parseTimeout = setTimeout(() => {
			util.log('print pdf timed out for', tab.prerender.url);
			tab.prerender.statusCode = 504;
			reject();
		}, 5000);

		tab.Page.printToPDF(options).then((response) => {
			tab.prerender.content = new Buffer(response.data, 'base64');
			clearTimeout(parseTimeout);
			resolve();
		}).catch((err) => {
			util.log('unable to capture pdf:', err);
			tab.prerender.statusCode = 504;
			clearTimeout(parseTimeout);
			reject();
		});

	});
};


chrome.getHarFile = function(tab) {
	return new Promise((resolve, reject) => {

		var packageInfo = require('../../package');

		const firstRequest = tab.prerender.pageLoadInfo.entries[tab.prerender.pageLoadInfo.firstRequestId].requestParams;
		const wallTimeMs = firstRequest.wallTime * 1000;
		const startedDateTime = new Date(wallTimeMs).toISOString();
		const onContentLoad = tab.prerender.pageLoadInfo.domContentEventFiredMs - tab.prerender.pageLoadInfo.firstRequestMs;
		const onLoad = tab.prerender.pageLoadInfo.loadEventFiredMs - tab.prerender.pageLoadInfo.firstRequestMs;
		const entries = parseEntries(tab.prerender.pageLoadInfo.entries);

		tab.prerender.content = {
			log: {
				version: '1.2',
				creator: {
					name: 'Prerender HAR Capturer',
					version: packageInfo.version,
					comment: packageInfo.homepage
				},
				pages: [
					{
						id: 'page_1',
						title: tab.prerender.url,
						startedDateTime: startedDateTime,
						pageTimings: {
							onContentLoad: onContentLoad,
							onLoad: onLoad
						}
					}
				],
				entries: entries
			}
		};

		resolve();

	});
};



function parseEntries(entries) {

	let harEntries = [];

	Object.keys(entries).forEach((key) => {

		let entry = entries[key];

		if (!entry.responseParams || !entry.responseFinishedS && !entry.responseFailedS) {
			return null;
		}

		if (!entry.responseParams.response.timing) {
			return null;
		}

		const {request} = entry.requestParams;
		const {response} = entry.responseParams;

		const wallTimeMs = entry.requestParams.wallTime * 1000;
		const startedDateTime = new Date(wallTimeMs).toISOString();
		const httpVersion = response.protocol || 'unknown';
		const {method} = request;
		const loadedUrl = request.url;
		const {status, statusText} = response;
		const headers = parseHeaders(httpVersion, request, response);
		const redirectURL = getHeaderValue(response.headers, 'location', '');
		const queryString = url.parse(request.url, true).query;
		const {time, timings} = computeTimings(entry);

		let serverIPAddress = response.remoteIPAddress;
		if (serverIPAddress) {
			serverIPAddress = serverIPAddress.replace(/^\[(.*)\]$/, '$1');
		}

		const connection = String(response.connectionId);
		const _initiator = entry.requestParams.initiator;
		const {changedPriority} = entry;
		const newPriority = changedPriority && changedPriority.newPriority;
		const _priority = newPriority || request.initialPriority;
		const payload = computePayload(entry, headers);
		const {mimeType} = response;
		const encoding = entry.responseBodyIsBase64 ? 'base64' : undefined;

		harEntries.push({
			pageref: 'page_1',
			startedDateTime,
			time,
			request: {
				method,
				url: loadedUrl,
				httpVersion,
				cookies: [], // TODO
				headers: headers.request.pairs,
				queryString,
				headersSize: headers.request.size,
				bodySize: payload.request.bodySize
				// TODO postData
			},
			response: {
				status,
				statusText,
				httpVersion,
				cookies: [], // TODO
				headers: headers.response.pairs,
				redirectURL,
				headersSize: headers.response.size,
				bodySize: payload.response.bodySize,
				_transferSize: payload.response.transferSize,
				content: {
					size: entry.responseLength,
					mimeType,
					compression: payload.response.compression,
					text: entry.responseBody,
					encoding
				}
			},
			cache: {},
			timings,
			serverIPAddress,
			connection,
			_initiator,
			_priority
		});
	});

	return harEntries;
};


function parseHeaders(httpVersion, request, response) {
	// convert headers from map to pairs
	const requestHeaders = response.requestHeaders || request.headers;
	const responseHeaders = response.headers;
	const headers = {
		request: {
			map: requestHeaders,
			pairs: zipNameValue(requestHeaders),
			size: -1
		},
		response: {
			map: responseHeaders,
			pairs: zipNameValue(responseHeaders),
			size: -1
		}
	};
	// estimate the header size (including HTTP status line) according to the
	// protocol (this information not available due to possible compression in
	// newer versions of HTTP)
	if (httpVersion.match(/^http\/[01].[01]$/)) {
		const requestText = getRawRequest(request, headers.request.pairs);
		const responseText = getRawResponse(response, headers.response.pairs);
		headers.request.size = requestText.length;
		headers.response.size = responseText.length;
	}
	return headers;
}


function computePayload(entry, headers) {
	// From Chrome:
	//  - responseHeaders.size: size of the headers if available (otherwise
	//    -1, e.g., HTTP/2)
	//  - entry.responseLength: actual *decoded* body size
	//  - entry.encodedResponseLength: total on-the-wire data
	//
	// To HAR:
	//  - headersSize: size of the headers if available (otherwise -1, e.g.,
	//    HTTP/2)
	//  - bodySize: *encoded* body size
	//  - _transferSize: total on-the-wire data
	//  - content.size: *decoded* body size
	//  - content.compression: *decoded* body size - *encoded* body size
	let bodySize;
	let compression;
	let transferSize = entry.encodedResponseLength;
	if (headers.response.size === -1) {
		// if the headers size is not available (e.g., newer versions of
		// HTTP) then there is no way (?) to figure out the encoded body
		// size (see #27)
		bodySize = -1;
		compression = undefined;
	} else if (entry.responseFailedS) {
		// for failed requests (`Network.loadingFailed`) the transferSize is
		// just the header size, since that evend does not hold the
		// `encodedDataLength` field, this is performed manually (however this
		// cannot be done for HTTP/2 which is handled by the above if)
		bodySize = 0;
		compression = 0;
		transferSize = headers.response.size;
	} else {
		// otherwise the encoded body size can be obtained as follows
		bodySize = entry.encodedResponseLength - headers.response.size;
		compression = entry.responseLength - bodySize;
	}
	return {
		request: {
			// trivial case for request
			bodySize: parseInt(getHeaderValue(headers.request.map, 'content-length', -1), 10)
		},
		response: {
			bodySize,
			transferSize,
			compression
		}
	};
}


function zipNameValue(map) {
	const pairs = [];

	Object.keys(map).forEach(function(name) {
		const value = map[name];
		const values = Array.isArray(value) ? value : [value];
		for (const value of values) {
			pairs.push({name, value});
		}
	});
	return pairs;
}

function getRawRequest(request, headerPairs) {
	const {method, url, protocol} = request;
	const lines = [`${method} ${url} ${protocol}`];
	for (const {name, value} of headerPairs) {
		lines.push(`${name}: ${value}`);
	}
	lines.push('', '');
	return lines.join('\r\n');
}

function getRawResponse(response, headerPairs) {
	const {status, statusText, protocol} = response;
	const lines = [`${protocol} ${status} ${statusText}`];
	for (const {name, value} of headerPairs) {
		lines.push(`${name}: ${value}`);
	}
	lines.push('', '');
	return lines.join('\r\n');
}


function getHeaderValue(headers, name, fallback) {
	const pattern = new RegExp(`^${name}$`, 'i');
	const key = Object.keys(headers).find((name) => {
		return name.match(pattern);
	});
	return key === undefined ? fallback : headers[key];
};


function computeTimings(entry) {
	// https://chromium.googlesource.com/chromium/blink.git/+/master/Source/devtools/front_end/sdk/HAREntry.js
	// fetch the original timing object and compute duration
	const timing = entry.responseParams.response.timing;
	const finishedTimestamp = entry.responseFinishedS || entry.responseFailedS;
	const time = toMilliseconds(finishedTimestamp - timing.requestTime);
	// compute individual components
	const blocked = firstNonNegative([
			timing.dnsStart, timing.connectStart, timing.sendStart
	]);
	let dns = -1;
	if (timing.dnsStart >= 0) {
			const start = firstNonNegative([timing.connectStart, timing.sendStart]);
			dns = start - timing.dnsStart;
	}
	let connect = -1;
	if (timing.connectStart >= 0) {
			connect = timing.sendStart - timing.connectStart;
	}
	const send = timing.sendEnd - timing.sendStart;
	const wait = timing.receiveHeadersEnd - timing.sendEnd;
	const receive = time - timing.receiveHeadersEnd;
	let ssl = -1;
	if (timing.sslStart >= 0 && timing.sslEnd >= 0) {
			ssl = timing.sslEnd - timing.sslStart;
	}
	return {
			time,
			timings: {blocked, dns, connect, send, wait, receive, ssl}
	};
};


function toMilliseconds(time) {
	return time === -1 ? -1 : time * 1000;
}

function firstNonNegative(values) {
	const value = values.find((value) => value >= 0);
	return value === undefined ? -1 : value;
}
