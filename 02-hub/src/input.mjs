export const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const fail = (message, status = 400) => Object.assign(new Error(message), {status});

export async function readJSON(request, limit = 8192) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw fail('Нужен JSON', 415);
  const bytes = await readBytes(request, limit);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw fail('Некорректный JSON', 400);
  }
}

export async function readBytes(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('Слишком большой запрос', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
