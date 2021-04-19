#!/usr/bin/env node
var prerender = require('./lib');

var server = prerender();

if (!server.options.omitPrerenderHeader) {
  // Doing this for localhost requests causes CORS errors.
  // server.use(prerender.sendPrerenderHeader());
}

// server.use(prerender.blockResources());
server.use(prerender.removeScriptTags());
server.use(prerender.httpHeaders());

server.start();
