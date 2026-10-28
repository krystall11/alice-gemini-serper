import handler from "../../api/index.js";

// Netlify принимает стандартные Request/Response; основная логика остаётся общей с Vercel.
export default async function alice(request) {
  let statusCode = 200;
  const headers = new Headers();
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    json(value) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
        status: statusCode,
        headers
      });
    }
  };

  const body = request.method === "POST" ? await request.text() : undefined;
  return handler({ method: request.method, body }, response);
}

export const config = { path: "/api" };
