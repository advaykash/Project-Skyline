// Cloudflare Workers entry point for Project Skyline. The logic and its comments are in ./api.mjs.
import { handle, refreshDue } from './api.mjs';

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (event, env, ctx) => { ctx.waitUntil(refreshDue(env).then(r => console.log('scheduled run', JSON.stringify(r)))); },
};
