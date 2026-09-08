// Cloudflare Worker static host for the TailSend Web Client (assets binding)
export default {
    async fetch(request, env) {
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("TailSend Web Client", { status: 200 });
    }
};
