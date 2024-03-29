import request from "supertest";
import { describe, it, before, after } from "node:test";
import { equal } from "node:assert/strict";
import { Test } from "@nestjs/testing";
import { InMemTestService, RedisTestService } from "./service";
import { HttpServer, INestApplication } from "@nestjs/common";
import { sleep } from "./util";
import { CacheModule } from "../cache.module";
import { InMemTestController, RedisTestController } from "./controller";
import { createClient, RedisClientType } from "redis";

const lessThan = (a: number, b: number) => equal(a < b, true);
const biggerThan = (a: number, b: number) => equal(a > b, true);

describe("e2e test of cache decorator", () => {
  let httpServer: HttpServer;
  let app: INestApplication;
  let service: InMemTestService;
  let client: RedisClientType;
  const requestBody = {
    "stringValue": "Hello, world!",
    "numberValue": 123,
    "objectValue": {
      "nestedString": "This is a string inside an object",
      "nestedNumber": 456,
      "nestedObject": {
        "anotherKey": "Another string"
      }
    },
    "arrayValue": ["string in array", 789, true, null, { "objectInArray": "value" }],
    "booleanValue": true,
    "nullValue": null
  };

  before(async () => {
    // start local redis server
    client = createClient({ url: "redis://localhost:6379" });
    await client.connect();
    await client.flushDb();

    // start server
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule],
      controllers: [InMemTestController, RedisTestController],
      providers: [InMemTestService, RedisTestService],
    }).compile();

    app = moduleRef.createNestApplication();

    await app.init();
    httpServer = app.getHttpServer();
    service = app.get<InMemTestService>(InMemTestService);
  });

  after(() => {
    client.flushDb();
    client.quit();
    app.close();
    httpServer.close();
  });

  describe("InMemCache", () => {
    it("should return immediately(set on start). test1 route", async () => {
      // give time to server execute and set cache...
      await sleep(1000);

      const start = Date.now();
      const response = await request(httpServer).get("/test1");
      const diff = Date.now() - start;

      equal(response.status, 200);
      equal(response.text, "test1");
      lessThan(diff, 50);
    });

    it("should return immediately(set on start) modified value. test2 route", async () => {
      // give time to server refresh cache...
      await sleep(3000);

      const start = Date.now();
      const response = await request(httpServer).get("/test2");
      const diff = Date.now() - start;

      equal(response.status, 200);
      equal(response.text, "modified test2");
      lessThan(diff, 50);
    });

    it("should return deferred value. because persistent cache busted", async () => {
      await request(httpServer).get("/test2/bust");
      const start = Date.now();
      const response = await request(httpServer).get("/test2");
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "modified test2");
    });

    it("even if cache value busted, it will automatically invoked internally, so request can get cached value", async () => {
      await request(httpServer).get("/test2/bust");
      await sleep(1050); // execution time 1 second + invoking time 50ms

      const start = Date.now();
      const response = await request(httpServer).get("/test2");
      const diff = Date.now() - start;

      lessThan(diff, 50);
      equal(response.text, "modified test2");
    });

    it("should return deferred value at first, then return cached value immediately", async () => {
      const start = Date.now();
      const response = await request(httpServer).get(
        "/test3/paramValue?query=queryValue"
      );
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "test3paramValuequeryValue");

      const start2 = Date.now();
      const response2 = await request(httpServer).get(
        "/test3/paramValue?query=queryValue"
      );
      const diff2 = Date.now() - start2;

      lessThan(diff2, 50);
      equal(response2.text, "test3paramValuequeryValue");
    });

    it("should return both deferred value if referenced value is different(parameter combined cache)", async () => {
      const start = Date.now();
      const response = await request(httpServer).get(
        "/test3/param1?query=query1"
      );
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "test3param1query1");

      const start2 = Date.now();
      const response2 = await request(httpServer).get(
        "/test3/param2?query=query1"
      );
      const diff2 = Date.now() - start2;

      biggerThan(diff2, 1000);
      equal(response2.text, "test3param2query1");
    });

    it("should work with object parameters", async () => {
      const start = Date.now();
      const response = await request(httpServer).post("/test3").send(requestBody);
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "test3" + Object.keys(requestBody).join(""));

      const start2 = Date.now();
      const response2 = await request(httpServer).post("/test3").send(requestBody);
      const diff2 = Date.now() - start2;

      lessThan(diff2, 50);
      equal(response2.text, "test3" + Object.keys(requestBody).join(""));

      const start3 = Date.now();
      const modifiedRequestBody = {...requestBody, "stringValue": "modified"};
      const response3 = await request(httpServer).post("/test3").send(modifiedRequestBody);
      const diff3 = Date.now() - start3;

      biggerThan(diff3, 1000);
      equal(response3.text, "test3" + Object.keys(modifiedRequestBody).join(""));
    });

    it("should work with array parameters", async () => {
      const array = [1, 'hi', true, {a: 1}, [1, 2], null];
      const start = Date.now();
      const result = await service.cacheableTaskwithArrayParam(array);
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(result, array.join(""));

      const start2 = Date.now();
      const result2 = await service.cacheableTaskwithArrayParam(array);
      const diff2 = Date.now() - start2;

      lessThan(diff2, 50);
      equal(result2, array.join(""));

      const start3 = Date.now();
      const modifiedArray = [...array, 2];
      const result3 = await service.cacheableTaskwithArrayParam(modifiedArray);
      const diff3 = Date.now() - start3;

      biggerThan(diff3, 1000);
      equal(result3, modifiedArray.join(""));
    });

    it("should cache injectable partially so whole Request-Response cycle can divided into optimizable sections", async () => {
      const rawStart = Date.now();
      const response = await request(httpServer).get("/test4");
      const diff = Date.now() - rawStart;

      biggerThan(diff, 3000);
      equal(response.text, "test4");

      const start = Date.now();
      const response2 = await request(httpServer).get("/test4");
      const diff2 = Date.now() - start;

      biggerThan(diff2, 1000);
      lessThan(diff2, 1100);
      equal(response2.text, "test4");
    });
  });

  describe("RedisCache", () => {
    it("should return immediately(set on start). RedisTest1 route", async () => {
      // give time to server execute and set cache...
      await sleep(1000);

      const start = Date.now();
      const response = await request(httpServer).get("/RedisTest1");
      const diff = Date.now() - start;

      equal(response.status, 200);
      equal(response.text, "RedisTest1");
      lessThan(diff, 50);
    });

    it("should return immediately(set on start) modified value. RedisTest2 route", async () => {
      // give time to server refresh cache...
      await sleep(3000);

      const start = Date.now();
      const response = await request(httpServer).get("/RedisTest2");
      const diff = Date.now() - start;

      equal(response.status, 200);
      equal(response.text, "modified RedisTest2");
      lessThan(diff, 50);
    });

    it("should return deferred value. because persistent cache busted", async () => {
      await request(httpServer).get("/RedisTest2/bust");
      const start = Date.now();
      const response = await request(httpServer).get("/RedisTest2");
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "modified RedisTest2");
    });

    it("even if cache value busted, it will automatically invoked internally, so request can get cached value", async () => {
      await request(httpServer).get("/RedisTest2/bust");
      await sleep(1050); // execution time 1 second + invoking time 50ms

      const start = Date.now();
      const response = await request(httpServer).get("/RedisTest2");
      const diff = Date.now() - start;

      lessThan(diff, 50);
      equal(response.text, "modified RedisTest2");
    });

    it("should return deferred value at first, then return cached value immediately", async () => {
      const start = Date.now();
      const response = await request(httpServer).get(
        "/RedisTest3/paramValue?query=queryValue"
      );
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "RedisTest3paramValuequeryValue");

      const start2 = Date.now();
      const response2 = await request(httpServer).get(
        "/RedisTest3/paramValue?query=queryValue"
      );
      const diff2 = Date.now() - start2;

      lessThan(diff2, 50);
      equal(response2.text, "RedisTest3paramValuequeryValue");
    });

    it("should return both deferred value if referenced value is different(parameter combined cache)", async () => {
      const start = Date.now();
      const response = await request(httpServer).get(
        "/RedisTest3/param1?query=query1"
      );
      const diff = Date.now() - start;

      biggerThan(diff, 1000);
      equal(response.text, "RedisTest3param1query1");

      const start2 = Date.now();
      const response2 = await request(httpServer).get(
        "/RedisTest3/param2?query=query1"
      );
      const diff2 = Date.now() - start2;

      biggerThan(diff2, 1000);
      equal(response2.text, "RedisTest3param2query1");
    });

    it("should cache injectable partially so whole Request-Response cycle can divided into optimizable sections", async () => {
      const rawStart = Date.now();
      const response = await request(httpServer).get("/RedisTest4");
      const diff = Date.now() - rawStart;

      biggerThan(diff, 3000);
      equal(response.text, "RedisTest4");

      const start = Date.now();
      const response2 = await request(httpServer).get("/RedisTest4");
      const diff2 = Date.now() - start;

      biggerThan(diff2, 1000);
      lessThan(diff2, 1100);
      equal(response2.text, "RedisTest4");
    });
  });

  it("should return immediately(set on start).test5 route(decorator order is reversed)", async () => {
    await sleep(1000);

    const start = Date.now();
    const response = await request(httpServer).get("/test5");
    const diff = Date.now() - start;

    equal(response.status, 200);
    equal(response.text, "test5");
    lessThan(diff, 50);
  });
});
