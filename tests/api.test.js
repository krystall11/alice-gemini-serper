import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  aliceResponse,
  buildSearchQuery,
  fitAliceText,
  isHelpIntent,
  isSearchIntent,
  isStopIntent,
  resetCaches,
  safeHistory,
  trimHistoryToBudget
} from "../api/index.js";

const ENV_KEYS = ["GEMINI_API_KEY", "SERPER_API_KEY", "GEMINI_MODEL", "YANDEX_SKILL_ID", "TIME_ZONE"];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function restoreEnvironment() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  };
}

function createResponse() {
  const state = { statusCode: 200, payload: undefined, headers: {} };
  const res = {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(value) {
      state.payload = value;
      return value;
    },
    setHeader(name, value) {
      state.headers[name] = value;
    }
  };
  return { res, state };
}

async function callHandler(req) {
  const { res, state } = createResponse();
  await handler(req, res);
  return state;
}

function cleanup(t) {
  t.after(() => {
    globalThis.fetch = originalFetch;
    restoreEnvironment();
    resetCaches();
  });
}

test("Alice response uses the required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("Alice session_state always stays under the Yandex 1 KB limit", () => {
  const longHistory = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: "Очень длинный ответ на русском языке. ".repeat(30)
  }));

  const result = aliceResponse("Ответ", false, longHistory);
  const bytes = Buffer.byteLength(JSON.stringify(result.session_state), "utf8");

  assert.ok(bytes <= 1024, `session_state is ${bytes} bytes`);
  assert.ok(result.session_state.history.length > 0);
  assert.equal(result.session_state.history[0].role, "user");
});

test("Alice response adds sanitized buttons", () => {
  const result = aliceResponse("Привет", false, [], {
    buttons: [
      { title: "Погода" },
      { title: "", hide: true },
      { title: "x".repeat(100) }
    ]
  });

  assert.equal(result.response.buttons.length, 2);
  assert.equal(result.response.buttons[0].title, "Погода");
  assert.equal(result.response.buttons[0].hide, true);
  assert.equal(result.response.buttons[1].title.length, 64);
});

test("fitAliceText strips Markdown, links, HTML and emoji for voice output", () => {
  assert.equal(
    fitAliceText("**Привет**, [ссылка](https://example.com)! 😊"),
    "Привет, ссылка!"
  );
  assert.equal(fitAliceText("<b>Привет</b> &amp; пока!"), "Привет и пока!");
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("fitAliceText returns a safe fallback for empty text", () => {
  assert.equal(fitAliceText(""), "Не удалось подготовить ответ.");
});

test("search intent detects fresh-data questions without obvious false positives", () => {
  const positive = [
    "Какая погода сегодня?",
    "What is the latest news?",
    "Курс доллара",
    "Найди рецепт борща",
    "Сколько стоит iPhone?",
    "Когда матч Спартак?",
    "Что нового?",
    "Где купить билеты?"
  ];
  const negative = [
    "Расскажи сказку",
    "Как дела?",
    "Что ты делаешь сейчас?",
    "Сколько будет 2+2?",
    "Который час?",
    "Кто такой Пушкин?",
    "Европейский суд"
  ];

  for (const text of positive) assert.equal(isSearchIntent(text), true, text);
  for (const text of negative) assert.equal(isSearchIntent(text), false, text);
});

test("search query removes the wake word, politeness and search verb", () => {
  assert.equal(buildSearchQuery("Алиса, найди мне погоду в Москве"), "погоду в Москве");
  assert.equal(buildSearchQuery("Пожалуйста, какая погода?"), "какая погода?");
});

test("history filters malformed messages and keeps the last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: String(i)
  }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });

  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("history merges same-role messages and never starts with a model reply", () => {
  const result = safeHistory([
    { role: "model", text: "осиротевший ответ" },
    { role: "user", text: "привет" },
    { role: "user", text: "как дела" },
    { role: "model", text: "хорошо" }
  ]);

  assert.deepEqual(result, [
    { role: "user", text: "привет как дела" },
    { role: "model", text: "хорошо" }
  ]);
});

test("trimHistoryToBudget preserves the newest exchange and fits the byte limit", () => {
  const history = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: `Сообщение ${i}. `.repeat(40)
  }));

  const trimmed = trimHistoryToBudget(history);
  const bytes = Buffer.byteLength(JSON.stringify({ history: trimmed }), "utf8");

  assert.ok(bytes <= 950, `history is ${bytes} bytes`);
  assert.ok(trimmed.length > 0);
  assert.equal(trimmed[0].role, "user");
  assert.match(trimmed.at(-1).text, /^Сообщение 7\./);
});

test("stop and help intents are recognized", () => {
  assert.equal(isStopIntent("Пока!"), true);
  assert.equal(isStopIntent("Пока,"), true);
  assert.equal(isStopIntent("Спасибо, до свидания"), true);
  assert.equal(isStopIntent("Закончи разговор"), true);
  assert.equal(isStopIntent("Покажи погоду"), false);

  assert.equal(isHelpIntent("Что ты умеешь?"), true);
  assert.equal(isHelpIntent("Что ты умеешь делать?"), true);
  assert.equal(isHelpIntent("Какие команды?"), true);
  assert.equal(isHelpIntent("Расскажи, что ты умеешь"), true);
  assert.equal(isHelpIntent("Помощь с домашним заданием"), false);
  assert.equal(isHelpIntent("Что можно узнать о погоде?"), false);
  assert.equal(isSearchIntent("Что можно узнать о погоде?"), true);
});

test("GET health check reports configuration without exposing secrets", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.SERPER_API_KEY;
  process.env.GEMINI_MODEL = "models/gemini-3.5-flash-lite";

  const state = await callHandler({ method: "GET" });

  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.ok, true);
  assert.equal(state.payload.service, "alice-gemini-serper");
  assert.equal(state.payload.version, "1.1.0");
  assert.equal(state.payload.geminiConfigured, true);
  assert.equal(state.payload.searchConfigured, false);
  assert.equal(state.payload.model, "gemini-3.5-flash-lite");
  assert.equal(state.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify(state.payload).includes("test-gemini-key"), false);
});

test("launch request returns a valid greeting without external API keys", async t => {
  cleanup(t);
  delete process.env.GEMINI_API_KEY;
  delete process.env.SERPER_API_KEY;

  const state = await callHandler({
    method: "POST",
    body: { request: { command: "" }, state: { session: { history: [] } } }
  });

  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.version, "1.0");
  assert.match(state.payload.response.text, /Привет/);
  assert.equal(state.payload.response.end_session, false);
  assert.equal(state.payload.response.buttons.length, 3);
});

test("help and stop commands work without calling external APIs", async t => {
  cleanup(t);
  delete process.env.GEMINI_API_KEY;
  delete process.env.SERPER_API_KEY;

  const help = await callHandler({
    method: "POST",
    body: { request: { command: "Что ты умеешь?" }, state: { session: { history: [] } } }
  });
  assert.equal(help.statusCode, 200);
  assert.match(help.payload.response.text, /погоде/);
  assert.equal(help.payload.response.buttons.length, 3);

  const stop = await callHandler({
    method: "POST",
    body: { request: { command: "Пока" }, state: { session: { history: [] } } }
  });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.payload.response.end_session, true);
  assert.match(stop.payload.response.text, /Пока/);
});

test("normal question calls Gemini, filters thoughts and stores compact history", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.SERPER_API_KEY;

  let geminiBody;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /generateContent/);
    geminiBody = JSON.parse(options.body);
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [
              { text: "Внутренняя мысль, которую нельзя озвучивать.", thought: true },
              { text: "**Всё хорошо!**" }
            ]
          },
          finishReason: "STOP"
        }
      ]
    });
  };

  const state = await callHandler({
    method: "POST",
    body: {
      session: { new: false },
      request: { command: "Привет, как дела?" },
      state: { session: { history: [] } }
    }
  });

  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.response.text, "Всё хорошо!");
  assert.equal(state.payload.response.end_session, false);
  assert.equal(state.payload.session_state.history.length, 2);
  assert.equal(state.payload.session_state.history[0].role, "user");
  assert.equal(state.payload.session_state.history[1].role, "model");
  assert.ok(
    Buffer.byteLength(JSON.stringify(state.payload.session_state), "utf8") <= 1024
  );

  assert.equal(geminiBody.contents.at(-1).parts[0].text, "Привет, как дела?");
  assert.equal(geminiBody.generationConfig.maxOutputTokens, 300);
  assert.match(geminiBody.systemInstruction.parts[0].text, /голосовой помощник/);
  assert.match(geminiBody.systemInstruction.parts[0].text, /недоверенные данные/);
});

test("Gemini always receives alternating roles even with a dangling user message", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.SERPER_API_KEY;

  let roles;
  globalThis.fetch = async (url, options) => {
    roles = JSON.parse(options.body).contents.map(item => item.role);
    return jsonResponse({
      candidates: [
        { content: { parts: [{ text: "Ответ." }] }, finishReason: "STOP" }
      ]
    });
  };

  const state = await callHandler({
    method: "POST",
    body: {
      session: { new: false },
      request: { command: "Продолжи" },
      state: {
        session: {
          history: [
            { role: "user", text: "Первый вопрос" },
            { role: "model", text: "Первый ответ" },
            { role: "user", text: "Неотвеченный вопрос" }
          ]
        }
      }
    }
  });

  assert.equal(state.statusCode, 200);
  assert.deepEqual(roles, ["user", "model", "user"]);
});

test("search intent uses Serper, passes context to Gemini and caches search results", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.SERPER_API_KEY = "test-serper-key";
  resetCaches();

  let serperBody;
  let geminiBody;
  let serperCalls = 0;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("serper.dev")) {
      serperCalls += 1;
      serperBody = JSON.parse(options.body);
      return jsonResponse({
        answerBox: { answer: "В Москве плюс десять градусов." },
        organic: [{ title: "Погода в Москве", snippet: "Тепло и солнечно." }]
      });
    }

    geminiBody = JSON.parse(options.body);
    return jsonResponse({
      candidates: [
        {
          content: { parts: [{ text: "В Москве плюс десять градусов." }] },
          finishReason: "STOP"
        }
      ]
    });
  };

  const request = {
    method: "POST",
    body: {
      session: { new: false },
      request: { command: "Алиса, найди погоду в Москве" },
      state: { session: { history: [] } }
    }
  };

  const first = await callHandler(request);
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.response.text, "В Москве плюс десять градусов.");
  assert.equal(serperBody.q, "погоду в Москве");
  assert.match(geminiBody.contents.at(-1).parts[0].text, /<search_results>/);
  assert.match(geminiBody.contents.at(-1).parts[0].text, /плюс десять градусов/);

  const secondRequest = {
    ...request,
    body: {
      ...request.body,
      state: first.payload.session_state
    }
  };
  const second = await callHandler(secondRequest);
  assert.equal(second.statusCode, 200);
  assert.equal(serperCalls, 1, "the second identical search should come from cache");
});

test("Gemini errors return a safe Alice fallback instead of a server error", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "bad-key";
  delete process.env.SERPER_API_KEY;

  globalThis.fetch = async () =>
    jsonResponse({ error: { status: "API_KEY_INVALID" } }, 401);

  const state = await callHandler({
    method: "POST",
    body: {
      session: { new: false },
      request: { command: "Привет" },
      state: { session: { history: [] } }
    }
  });

  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.response.end_session, false);
  assert.match(state.payload.response.text, /API-ключ/);
});

test("invalid API key returned as HTTP 400 is still reported as a key problem", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "bad-key";
  delete process.env.SERPER_API_KEY;

  globalThis.fetch = async () =>
    jsonResponse(
      {
        error: {
          status: "INVALID_ARGUMENT",
          message: "API key not valid. Please pass a valid API key.",
          details: [{ reason: "API_KEY_INVALID" }]
        }
      },
      400
    );

  const state = await callHandler({
    method: "POST",
    body: {
      session: { new: false },
      request: { command: "Привет" },
      state: { session: { history: [] } }
    }
  });

  assert.equal(state.statusCode, 200);
  assert.match(state.payload.response.text, /API-ключ/);
});

test("optional skill ID lock rejects foreign requests", async t => {
  cleanup(t);
  process.env.YANDEX_SKILL_ID = "skill-123";
  delete process.env.GEMINI_API_KEY;
  delete process.env.SERPER_API_KEY;

  const foreign = await callHandler({
    method: "POST",
    body: {
      session: { skill_id: "another-skill" },
      request: { command: "Привет" }
    }
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.payload.error, "Forbidden");

  const own = await callHandler({
    method: "POST",
    body: {
      session: { skill_id: "skill-123" },
      request: { command: "" },
      state: { session: { history: [] } }
    }
  });
  assert.equal(own.statusCode, 200);
  assert.match(own.payload.response.text, /Привет/);
});

test("string request bodies are parsed like Vercel JSON bodies", async t => {
  cleanup(t);
  delete process.env.GEMINI_API_KEY;
  delete process.env.SERPER_API_KEY;

  const state = await callHandler({
    method: "POST",
    body: JSON.stringify({
      request: { command: "Пока" },
      state: { session: { history: [] } }
    })
  });

  assert.equal(state.statusCode, 200);
  assert.equal(state.payload.response.end_session, true);
});

test("very long user input is capped before it reaches Gemini", async t => {
  cleanup(t);
  process.env.GEMINI_API_KEY = "test-gemini-key";
  delete process.env.SERPER_API_KEY;

  let prompt = "";
  globalThis.fetch = async (url, options) => {
    prompt = JSON.parse(options.body).contents.at(-1).parts[0].text;
    return jsonResponse({
      candidates: [
        { content: { parts: [{ text: "Короткий ответ." }] }, finishReason: "STOP" }
      ]
    });
  };

  const state = await callHandler({
    method: "POST",
    body: {
      session: { new: false },
      request: { command: "а".repeat(5000) },
      state: { session: { history: [] } }
    }
  });

  assert.equal(state.statusCode, 200);
  assert.ok(prompt.length <= 1000, `prompt is ${prompt.length} characters`);
});
