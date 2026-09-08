export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "mktailcatsend.pages.dev") {
    url.hostname = "ponlet.mat2uken.app";
    return Response.redirect(url.toString(), 301);
  }
  return await context.next();
}
