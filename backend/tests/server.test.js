import { jest, test, expect, beforeAll, afterAll } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-local-tests';

const { app } = await import('../src/server.js');
const request = (await import('supertest')).default;
let server;

beforeAll(() => {
  server = app.listen(0);
});

afterAll(() => {
  server.close();
});

test('unknown API route returns JSON 404', async () => {
  const response = await request(server).get('/api/test-route-that-does-not-exist');

  expect(response.status).toBe(404);
  expect(response.body).toEqual({ message: 'Not found' });
});
test('GET /api/me rejects unauthenticated requests', async () => {
  const response = await request(server).get('/api/me');

  expect(response.status).toBe(401);
});