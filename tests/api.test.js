const axios = require("axios");

// Inside the docker network the API is reachable by its service name: "app"
const API = "http://app:3000";

// Retry mechanism: wait until the API is ready before running the tests
async function waitForApi(retries = 20) {
  for (let i = 1; i <= retries; i++) {
    try {
      await axios.get(`${API}/users`);
      return;
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("API not reachable");
}

beforeAll(async () => {
  await waitForApi();
  // Reset the database so the tests are repeatable (the volume keeps data between runs)
  await axios.delete(`${API}/users`);
});

// Test 1: Create a user and verify the list (end-to-end: test -> API -> database)
test("create user", async () => {
  // Step 1: Create a user
  await axios.post(`${API}/users`, { name: "John" });

  // Step 2: Fetch the user list
  const response = await axios.get(`${API}/users`);

  // Step 3: Verify there is exactly 1 user and that it is John
  expect(response.data.length).toBe(1);
  expect(response.data[0].name).toBe("John");
});

// Test 2 (extra - GET test): the list is an array and contains the created user
test("get users returns list with created user", async () => {
  const response = await axios.get(`${API}/users`);

  expect(response.status).toBe(200);
  expect(Array.isArray(response.data)).toBe(true);
  expect(response.data.map((u) => u.name)).toContain("John");
});

// Test 3 (extra - validation): POST without a name returns 400
test("post without name returns 400", async () => {
  const response = await axios.post(
    `${API}/users`,
    {},
    { validateStatus: () => true }
  );

  expect(response.status).toBe(400);
});

// Test 4 (extra - DELETE test): deleting empties the user list
test("delete users empties the list", async () => {
  await axios.delete(`${API}/users`);

  const response = await axios.get(`${API}/users`);
  expect(response.data.length).toBe(0);
});

// Test 5 (final assignment - new test added via pull request):
// adding a user after deletion fills the list again
test("second user is added to the list", async () => {
  await axios.post(`${API}/users`, { name: "Marko" });

  const response = await axios.get(`${API}/users`);
  expect(response.data.map((u) => u.name)).toContain("Marko");
});
