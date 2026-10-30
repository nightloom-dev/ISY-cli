import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLines, parseTranscriptFile, shellEditPaths } from "../parser.js";
import { BUILTIN_RULES, REDACTION_MARKER, applyRules, marker, redactLineStream, redactLines, redactTranscriptFile } from "../redact.js";

function redactOne(text: string, extraPatterns?: string[]): string {
  const record = { type: "user", message: { role: "user", content: text } };
  const { lines } = redactLines([JSON.stringify(record)], { extraPatterns });
  const parsed = JSON.parse(lines[0]!) as { message: { content: string } };
  return parsed.message.content;
}

function summaryFor(records: unknown[]) {
  return redactLines(records.map((record) => JSON.stringify(record)));
}

/** One tool call and its result as Claude Code records them, and what came out of each. */
function throughCall(name: string, input: Record<string, unknown>, output = "MAILER_PHRASE=Zq8vR2mK9xLp") {
  const { lines } = summaryFor([
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: output }] }, toolUseResult: { stdout: output } },
  ]);
  const [call, result] = lines.map((line) => JSON.parse(line) as {
    message: { content: { input: Record<string, unknown>; content: unknown }[] };
    toolUseResult?: unknown;
  });
  return { input: call!.message.content[0]!.input, content: result!.message.content[0]!.content, toolUseResult: result!.toolUseResult };
}

test("masks OpenAI-style provider keys", () => {
  const out = redactOne("export OPENAI=sk-abcdefghij0123456789XYZ done");
  assert.equal(out, `export OPENAI=${marker("openai_key")} done`);
});

test("masks Anthropic keys with their own label", () => {
  const out = redactOne("key sk-ant-api03-AAaaBBbbCCccDDddEEeeFF");
  assert.equal(out, `key ${marker("anthropic_key")}`);
});

test("does not treat an ordinary hyphenated word as a provider key", () => {
  const out = redactOne("the task-abcdefghij0123456789 identifier");
  assert.equal(out, "the task-abcdefghij0123456789 identifier");
});

test("masks every GitHub token prefix", () => {
  const body = "a".repeat(36);
  for (const prefix of ["ghp", "gho", "ghs", "ghu"]) {
    assert.equal(redactOne(`${prefix}_${body}`), marker("github_token"));
  }
  assert.equal(redactOne(`github_pat_${"b".repeat(24)}`), marker("github_token"));
});

test("masks AWS access key ids", () => {
  assert.equal(redactOne(`id AKIA${"A".repeat(16)}`), `id ${marker("aws_key")}`);
  assert.equal(redactOne(`id ASIA${"1".repeat(16)}`), `id ${marker("aws_key")}`);
});

test("masks Google API keys", () => {
  assert.equal(redactOne(`AIza${"x".repeat(35)}`), marker("google_key"));
});

test("masks Stripe secret keys, Slack and npm tokens, and an opaque bearer token", () => {
  const body = "a1B2c3D4e5F6g7H8i9J0k1L2";
  assert.equal(redactOne(`sk_live_${body}`), marker("stripe_key"));
  assert.equal(redactOne(`rk_test_${body}`), marker("stripe_key"));
  assert.equal(redactOne(`SLACK=xoxb-123456789012-1234567890123-${body}`), `SLACK=${marker("slack_token")}`);
  assert.equal(redactOne(`npm_${"a1".repeat(18)}`), marker("npm_token"));
  assert.equal(redactOne(`Authorization: Bearer ${body}`), `Authorization: Bearer ${marker("bearer_token")}`);
  assert.equal(redactOne(`Bearer ghp_${"a".repeat(36)}`), `Bearer ${marker("github_token")}`);
  assert.equal(redactOne("Bearer tokens travel in the Authorization header"), "Bearer tokens travel in the Authorization header");
});

test("masks a whole PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactOne(`before ${pem} after`), `before ${marker("private_key")} after`);
});

test("masks a truncated private key that never reaches its end marker", () => {
  const out = redactOne("-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEowIBAAKCAQEA");
  assert.equal(out, marker("private_key"));
});

test("masks JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(redactOne(`Authorization: Bearer ${jwt}`), `Authorization: Bearer ${marker("jwt")}`);
});

test("masks only the password inside a connection string", () => {
  const out = redactOne("postgres://appuser:hunter2000@db.internal:5432/isy");
  assert.equal(out, `postgres://appuser:${marker("connection_string")}@db.internal:5432/isy`);
});

test("masks connection string passwords for every supported scheme", () => {
  for (const scheme of ["postgresql", "mysql", "mongodb", "redis", "amqp"]) {
    const out = redactOne(`${scheme}://user:secretpass@host/db`);
    assert.equal(out, `${scheme}://user:${marker("connection_string")}@host/db`);
  }
});

test("masks the password in a URL of any scheme, and an armored PGP private key", () => {
  const masked = marker("connection_string");
  assert.equal(redactOne("rediss://default:hunter2000@cache.internal:6380"), `rediss://default:${masked}@cache.internal:6380`);
  assert.equal(redactOne("amqps://app:secretpass@mq.internal/vhost"), `amqps://app:${masked}@mq.internal/vhost`);
  assert.equal(redactOne("curl https://admin:hunter2000@10.0.0.5:8443/api"), `curl https://admin:${masked}@10.0.0.5:8443/api`);
  // A port is not a password: nothing in this URL is masked.
  assert.equal(redactOne("https://example.com:8080/a/@scope/pkg"), "https://example.com:8080/a/@scope/pkg");

  const pgp = "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF0abcd\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----";
  assert.equal(redactOne(`key:\n${pgp}\ndone`), `key:\n${marker("private_key")}\ndone`);
});

test("masks the value of a sensitive assignment and keeps the key", () => {
  assert.equal(redactOne('password = "hunter2000"'), `password = "${marker("assignment")}"`);
  assert.equal(redactOne("API_KEY: abcdefgh12345"), `API_KEY: ${marker("assignment")}`);
  assert.equal(redactOne("private-key=abcdefghijkl"), `private-key=${marker("assignment")}`);
});

test("masks a password passed on a command line, and nothing else on it", () => {
  const m = marker("assignment");
  const cut: [string, string][] = [
    ["app --password Zq8vR2mK9xLp --port 80", `app --password ${m} --port 80`],
    [`app --password "Zq8vR2mK9xLp"`, `app --password "${m}"`],
    ["app --password 'Zq8vR2mK9xLp'", `app --password '${m}'`],
    ["app --token Zq8vR2mK9xLp", `app --token ${m}`],
    ["app --api-key Zq8vR2mK9xLp", `app --api-key ${m}`],
    ["app --apiKey Zq8vR2mK9xLp", `app --apiKey ${m}`],
    ["app --client-secret Zq8vR2mK9xLp", `app --client-secret ${m}`],
    ["Connect-App -Password Zq8vR2mK9xLp", `Connect-App -Password ${m}`],
    ["curl -u admin:Zq8vR2 http://127.0.0.1/", `curl -u admin:${m} http://127.0.0.1/`],
    ["curl -uadmin:Zq8vR2 http://127.0.0.1/", `curl -uadmin:${m} http://127.0.0.1/`],
    [`curl -u "admin:Zq8vR2" http://127.0.0.1/`, `curl -u "admin:${m}" http://127.0.0.1/`],
    ["curl --user admin:Zq8vR2 http://127.0.0.1/", `curl --user admin:${m} http://127.0.0.1/`],
    ["curl --user=admin:Zq8vR2 http://127.0.0.1/", `curl --user=admin:${m} http://127.0.0.1/`],
    [`curl -s "http://127.0.0.1/?a=1&b=2" -u admin:Zq8vR2`, `curl -s "http://127.0.0.1/?a=1&b=2" -u admin:${m}`],
    ["curl -U proxy:Zq8vR2 http://127.0.0.1/", `curl -U proxy:${m} http://127.0.0.1/`],
    ["curl -u me@example.com:Zq8vR2 http://127.0.0.1/", `curl -u ${marker("email")}:${m} http://127.0.0.1/`],
    ["mysql -h db -uroot -pZq8vR2 app", `mysql -h db -uroot -p${m} app`],
    ["mysqldump -pZq8vR2 app", `mysqldump -p${m} app`],
    ["sshpass -p Zq8vR2 ssh host", `sshpass -p ${m} ssh host`],
    ["sshpass -pZq8vR2 ssh host", `sshpass -p${m} ssh host`],
    ["redis-cli -h cache -a Zq8vR2 ping", `redis-cli -h cache -a ${m} ping`],
    ["docker login -u me -p Zq8vR2 ghcr.io", `docker login -u me -p ${m} ghcr.io`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }

  for (const text of [
    "app --password $APP_PASSWORD",
    `app --password "$APP_PASSWORD"`,
    "app --password-file /run/secrets/app",
    "docker login --password-stdin",
    "app --password --verbose",
    "app --token short",
    "app --max-tokens 1000000",
    `spawn("app", ["--password", password])`,
    "mkdir -p src/lib/deep",
    "ssh -p 2222 host",
    "mysql -p app",
    "docker run -p 8080:80 app",
    `curl -u "$API_USER:$API_PASS" http://127.0.0.1/`,
    "curl -u admin: http://127.0.0.1/",
    "curl -u admin http://127.0.0.1/",
    "curl http://127.0.0.1/ && grep -p x",
    "tar -xf a.tar -C out -p",
    "redis-cli -h cache ping",
  ]) {
    assert.equal(redactOne(text), text);
  }
});

test("masks an assigned secret whole when it holds a dollar sign or a bracket", () => {
  const m = marker("assignment");
  const cut: [string, string][] = [
    ["PASSWORD='abc$REST12345678'", `PASSWORD='${m}'`],
    ["PASSWORD=abcdefghij$TAILKEEP12", `PASSWORD=${m}`],
    ["export ADMIN_PASSWORD='abc$Qw7rTy2uIo9pAs4dFg1h'", `export ADMIN_PASSWORD='${m}'`],
    ["PASSWORD=abc(def)ghi12345", `PASSWORD=${m}`],
    ["PASSWORD='abc(defghij12345'", `PASSWORD='${m}'`],
    ["PASSWORD='$ecretPassw0rd'", `PASSWORD='${m}'`],
    [`{"password": "abc$def(ghi)12345"}`, `{"password": "${m}"}`],
    ["app --password abc$Qw7rTy2uIo9pAs4", `app --password ${m}`],
    [`{"accessToken":"abc$Qw7rTy2uIo9pAs4"}`, `{"accessToken":"${m}"}`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }

  for (const text of [
    "PASSWORD=$PASSWORD",
    `PASSWORD="$DB_PASS"`,
    "TOKEN=$(cat f)",
    "password=prefix${X}",
    "password = hash(input)",
    "token: foo(bar),",
    "secret: env('SECRET')",
    "password = md5($x);",
  ]) {
    assert.equal(redactOne(text), text);
  }
  // A call's long name goes, and what it is called with stays, as it always has.
  assert.equal(redactOne("token: getToken()"), `token: ${m}()`);
});

test("masks a value under PASS, PWD and the other names a credential goes by, not under words that hold them", () => {
  const m = marker("assignment");
  const cut: [string, string][] = [
    ["DB_PASS=Zq8vR2mK9xLp some-command", `DB_PASS=${m} some-command`],
    ["SMTP_PASS=Zq8vR2mK9xLp", `SMTP_PASS=${m}`],
    ["db-pass: Zq8vR2mK9xLp", `db-pass: ${m}`],
    ["pass=Zq8vR2mK9xLp", `pass=${m}`],
    ["PASS=Zq8vR2mK9xLp", `PASS=${m}`],
    ["dbPass=Zq8vR2mK9xLp", `dbPass=${m}`],
    [`{"dbPass":"Zq8vR2mK9xLp"}`, `{"dbPass":"${m}"}`],
    ["DB_PWD=Zq8vR2mK9xLp", `DB_PWD=${m}`],
    ["MYSQL_PWD=Zq8vR2mK9xLp mysql app", `MYSQL_PWD=${m} mysql app`],
    ["Server=db;Uid=sa;Pwd=Zq8vR2mK9xLp", `Server=db;Uid=sa;Pwd=${m}`],
    ["AUTH=Zq8vR2mK9xLp", `AUTH=${m}`],
    ["CREDENTIALS=Zq8vR2mK9xLp", `CREDENTIALS=${m}`],
    ["SERVICE_CREDENTIAL=Zq8vR2mK9xLp", `SERVICE_CREDENTIAL=${m}`],
    ["GPG_PASSPHRASE=Zq8vR2mK9xLp", `GPG_PASSPHRASE=${m}`],
    ["SESSION_COOKIE=Zq8vR2mK9xLp", `SESSION_COOKIE=${m}`],
    [`{"auth":"Zq8vR2mK9xLp"}`, `{"auth":"${m}"}`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }

  for (const text of [
    "compass=northbynorthwest",
    "COMPASS=northbynorthwest",
    "encompass: northbynorthwest",
    "bypass: northbynorthwest",
    "BYPASS=northbynorthwest",
    "byPass=northbynorthwest",
    "passes: northbynorthwest",
    "PWD=/srv/app/current",
    "OLDPWD=/srv/app/current",
    `{"pwd":"/srv/app/current"}`,
    "AUTHOR=northbynorthwest",
    "author: northbynorthwest",
    "AUTH_URL=https://example.com/login",
    "authenticated: northbynorthwest",
    `credentials: "include"`,
    "cookies: northbynorthwest",
  ]) {
    assert.equal(redactOne(text), text);
  }
});

test("masks what an Authorization or Cookie header carries, whatever its scheme or length", () => {
  const auth = marker("authorization");
  const bearer = marker("bearer_token");
  const cookie = marker("cookie");
  const cut: [string, string][] = [
    ["curl -H 'Authorization: Bearer abcdefghijklmnop' http://127.0.0.1/", `curl -H 'Authorization: Bearer ${auth}' http://127.0.0.1/`],
    ["curl -H 'Authorization: Bearer Zq8vR2mK9xLpWq7E' http://127.0.0.1/", `curl -H 'Authorization: Bearer ${bearer}' http://127.0.0.1/`],
    ["Authorization: Token abcdefghijkl", `Authorization: Token ${auth}`],
    ["authorization: Basic dXNlcjpwYXNz", `authorization: Basic ${auth}`],
    ["Proxy-Authorization: Basic dXNlcjpwYXNz", `Proxy-Authorization: Basic ${auth}`],
    [`"Authorization": "Basic dXNlcjpwYXNz"`, `"Authorization": "Basic ${auth}"`],
    [`headers: { Authorization: \`Basic dXNlcjpwYXNz\` }`, `headers: { Authorization: \`Basic ${auth}\` }`],
    ["Authorization: dXNlcjpwYXNz", `Authorization: ${marker("assignment")}`],
    ["Bearer Zq8vR2mK", `Bearer ${bearer}`],
    ["Cookie: sid=Zq8vR2mK9xLp; theme=dark", `Cookie: ${cookie}`],
    ["Set-Cookie: sid=Zq8vR2mK9xLp; Path=/; HttpOnly", `Set-Cookie: ${cookie}`],
    ["curl -H 'Cookie: sid=Zq8vR2mK9xLp; theme=dark' http://127.0.0.1/", `curl -H 'Cookie: ${cookie}' http://127.0.0.1/`],
    [`{"cookie": "sid=Zq8vR2mK9xLp; theme=dark"}`, `{"cookie": "${cookie}"}`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }

  for (const text of [
    "Bearer $TOKEN",
    "Bearer ${token}",
    "Bearer <token>",
    "Bearer authentication is what the docs call it",
    "Basic authentication is off",
    "Authorization: Bearer $TOKEN",
    "Authorization: Bearer ${token}",
    "Authorization: Bearer <token>",
    `curl -H "Authorization: Token $API_TOKEN" http://127.0.0.1/`,
    "the Authorization header carries it",
    "Cookie: $COOKIE",
    "Cookie: ${cookie}",
    "Cookie: <value>",
    "a cookie jar",
  ]) {
    assert.equal(redactOne(text), text);
  }

  const input = { headers: { Authorization: "Basic dXNlcjpwYXNz", Cookie: "sid=Zq8vR2mK9xLp; theme=dark" } };
  assert.deepEqual(throughCall("mcp__http__fetch", input, "plain output").input, {
    headers: { Authorization: marker("assignment"), Cookie: marker("assignment") },
  });
});

test("leaves short assignment values alone", () => {
  assert.equal(redactOne("password = short"), "password = short");
});

test("masks a snake_case key but not a camelCase variable in code", () => {
  assert.equal(redactOne("access_token = AbCdEf1234567890"), `access_token = ${marker("assignment")}`);
  assert.equal(redactOne("const adminPassword = someLongVariableName"), "const adminPassword = someLongVariableName");
});

test("masks a secret's name however a file spells it: quoted, with affixes, glued", () => {
  const masked = marker("assignment");
  const cases: [string, string][] = [
    ['{"password": "hunter2000"}', `{"password": "${masked}"}`],
    ['"client_secret": "abcdefgh1234"', `"client_secret": "${masked}"`],
    ['{"accessToken":"abcdefgh1234"}', `{"accessToken":"${masked}"}`],
    ["SECRET_KEY_BASE=abcdef0123456789", `SECRET_KEY_BASE=${masked}`],
    ["STRIPE_SECRET_KEY=whsec_abcdefgh", `STRIPE_SECRET_KEY=${masked}`],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG", `AWS_SECRET_ACCESS_KEY=${masked}`],
    ["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG", `aws_secret_access_key = ${masked}`],
    ["PGPASSWORD=hunter2000 psql -h db", `PGPASSWORD=${masked} psql -h db`],
    ["//registry.npmjs.org/:_authToken=abcdef123456", `//registry.npmjs.org/:_authToken=${masked}`],
    ["curl -H 'x-api-key: abcdef123456'", `curl -H 'x-api-key: ${masked}'`],
  ];
  for (const [input, expected] of cases) assert.equal(redactOne(input), expected, input);
});

test("leaves what is said about a secret alone, and code that only names one", () => {
  for (const text of [
    "tokenHash = computeTheHash(input)",
    "TOKENS_PER_ANALYSIS = 1_000_000",
    "POSTGRES_PASSWORD_FILE=/run/secrets/pg",
    "this.signingSecret = signingSecret",
    "accessTokenUrl: https://example.com/oauth",
    '"token": 1234567890, "isSecret": true',
  ]) {
    assert.equal(redactOne(text), text);
  }
});

test("a secret made of digits is still a secret", () => {
  const masked = marker("assignment");
  const cases: [string, string][] = [
    ["DB_PASSWORD=1234567890123", `DB_PASSWORD=${masked}`],
    ["MYSQL_ROOT_PASSWORD: 12345678", `MYSQL_ROOT_PASSWORD: ${masked}`],
    [`SECRET=${"1234567890".repeat(3)}12`, `SECRET=${masked}`],
    ['{"password": "12345678"}', `{"password": "${masked}"}`],
  ];
  for (const [input, expected] of cases) assert.equal(redactOne(input), expected, input);
});

test("an assistant record keeps its usage numbers, as JSON and as text", () => {
  const usage = { input_tokens: 3, cache_creation_input_tokens: 12345678, cache_read_input_tokens: 123456789, output_tokens: 87654321, max_tokens: 64000000 };
  const record = {
    type: "assistant",
    uuid: "a",
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `usage was ${JSON.stringify(usage)}` }], usage: { ...usage, service_tier: "standard" } },
  };
  // The last line of a transcript cut off mid-write is redacted as text.
  const { lines } = redactLines([JSON.stringify(record), JSON.stringify(record).slice(0, -2)]);

  const parsed = JSON.parse(lines[0]!) as typeof record;
  assert.deepEqual(parsed.message.usage, record.message.usage);
  assert.equal(parsed.message.content[0]!.text, record.message.content[0]!.text);
  assert.equal(lines[1], JSON.stringify(record).slice(0, -2));
});

test("leaves a value that is plainly code rather than a literal secret", () => {
  const jsx = "<OrdersTab accessToken={accessToken} />";
  assert.equal(redactOne(jsx), jsx);
  assert.equal(redactOne("token: string,"), "token: string,");
});

test("still masks an environment reference, erring toward over-redaction", () => {
  assert.equal(
    redactOne("api_key = process.env.OPENAI_KEY"),
    `api_key = ${marker("assignment")}`,
  );
});

test("does not redact an already redacted value a second time", () => {
  const out = redactOne(`api_key = sk-abcdefghij0123456789XYZ`);
  assert.equal(out, `api_key = ${marker("openai_key")}`);
});

test("masks a sensitive value carried as a JSON object key", () => {
  const { lines } = summaryFor([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] }, toolUseResult: { token: "abcdefghijklmnop" } },
  ]);
  const parsed = JSON.parse(lines[0]!) as { toolUseResult: { token: string } };
  assert.equal(parsed.toolUseResult.token, marker("assignment"));
});

test("cuts the body of a tool_result that read a dotenv file", () => {
  const { lines, summary } = summaryFor([
    {
      type: "assistant",
      uuid: "a",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/.env.local" } }],
      },
    },
    {
      type: "user",
      uuid: "b",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "STRIPE_LIVE=pk_live_totally_real" }],
      },
      toolUseResult: { stdout: "STRIPE_LIVE=pk_live_totally_real" },
    },
  ]);

  const result = JSON.parse(lines[1]!) as {
    message: { content: { content: string }[] };
    toolUseResult: string;
  };
  assert.equal(result.message.content[0]?.content, marker("dotenv"));
  assert.equal(result.toolUseResult, marker("dotenv"));
  assert.ok(summary.counts.dotenv! >= 2);
});

test("cuts dotenv content written through a Write tool call", () => {
  const { lines } = summaryFor([
    {
      type: "assistant",
      uuid: "a",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/repo/.env", content: "STRIPE_LIVE=pk_live_totally_real" },
          },
        ],
      },
    },
  ]);

  const record = JSON.parse(lines[0]!) as { message: { content: { input: { content: string } }[] } };
  assert.equal(record.message.content[0]?.input.content, marker("dotenv"));
});

test("cuts the result of a shell command that reads a dotenv file, and keeps the command", () => {
  const commands = [
    "cat .env.local",
    "grep -v '^#' config/.env.production | head -5",
    "set -a && source ./.env && npm run dev",
    "git show HEAD:.env",
    "ls -la .env*",
  ];
  const records = commands.flatMap((command, i) => [
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] } },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "STRIPE_LIVE=pk_live_totally_real" }] },
      toolUseResult: { stdout: "STRIPE_LIVE=pk_live_totally_real", stderr: "", interrupted: false },
    },
  ]);
  const out = summaryFor(records).lines.map((line) => JSON.parse(line) as {
    message: { content: { input?: { command: string }; content?: string }[] };
    toolUseResult?: unknown;
  });

  for (let i = 0; i < commands.length; i += 1) {
    assert.equal(out[i * 2]!.message.content[0]!.input!.command, commands[i]);
    const cut = i < commands.length - 1;
    assert.equal(out[i * 2 + 1]!.message.content[0]!.content === marker("dotenv"), cut, commands[i]);
    assert.equal(out[i * 2 + 1]!.toolUseResult === marker("dotenv"), cut, commands[i]);
  }
});

test("cuts the result of any shell command that names a dotenv file, and keeps the command", () => {
  const commands = [
    `node -e "console.log(require('fs').readFileSync('.env','utf8'))"`,
    `python3 -c "print(open('.env').read())"`,
    `python3 -c "\nimport re\nprint(re.findall('X', open('config/.env.local').read()))\n"`,
    "cut -d= -f2 .env.local",
    "tr -d x < .env",
    "sort .env",
    "base64 config/.env",
    "ssh host cat /app/.env",
    "docker exec app cat /app/.env",
    "if [ -f .env ]; then cat .env; fi",
    "(cat .env)",
    "timeout 5 cat .env",
    "time cat .env",
    "sudo -u app cat .env",
    "git show origin/main:.env",
    "git show HEAD:config/.env.local",
    "while read -r line; do echo \"$line\"; done < .env",
    "for f in .env*; do cut -d= -f2 \"$f\"; done",
    "F=.env; node -p \"require('dotenv').parse(require('fs').readFileSync('$F'))\"",
    "docker compose --env-file .env config",
    "node --env-file=.env -p process.env.MAILER_PHRASE",
    "echo `cat .env`",
    "echo \"$(tail -1 .env)\"",
    "Select-String -Path .env -Pattern PHRASE",
  ];
  for (const command of commands) {
    const out = throughCall("Bash", { command });
    assert.equal(out.content, marker("dotenv"), command);
    assert.equal(out.toolUseResult, marker("dotenv"), command);
    assert.equal(out.input.command, command);
  }
  assert.equal(throughCall("Monitor", { command: "tail -f .env" }).content, marker("dotenv"));
  assert.equal(throughCall("PowerShell", { command: "Get-Content .env" }).content, marker("dotenv"));
  assert.equal(throughCall("REPL", { code: "fs.readFileSync('.env', 'utf8')" }).content, marker("dotenv"));
  assert.equal(throughCall("exec", { script: "print(open('config/.env').read())" }).content, marker("dotenv"));
  assert.equal(throughCall("mcp__shell__run", { cmd: "cut -d= -f2 .env" }).content, marker("dotenv"));
  assert.equal(throughCall("Workflow", { script: "agent('cat .env and report')" }, "plain output").content, "plain output");
});

test("keeps the result of a command that names a dotenv file and prints none of it, or only names the word", () => {
  const commands = [
    "ls -la .env*",
    "ls -la .env* && git status",
    "ls -la config/.env.local",
    "stat .env",
    "file .env",
    "wc -l .env",
    "test -f .env",
    "[ -f .env ] && echo yes",
    "if [ -f .env ]; then echo yes; fi",
    "if ! test -f .env; then echo no; fi",
    "echo .env >> .gitignore",
    "printf '%s\\n' .env",
    "git add .env.example",
    "git rm --cached .env",
    "git commit -m 'stop tracking .env'",
    "git check-ignore -v .env",
    "git status --short .env",
    "git ls-files .env",
    "chmod 600 .env && npm test",
    "cp .env.example .env && npm test",
    "mv .env .env.bak; npm test; mv .env.bak .env",
    "rm -f .env && npm test",
    "touch .env && npm run build",
    `node -e "console.log(process.env.MAILER_PHRASE)"`,
    "npm test -- src/env.test.ts",
    "cat src/load-env.ts",
    "grep -rn 'import.meta.env.VITE_X' src",
    "rg '\\.env' src",
  ];
  for (const command of commands) {
    const out = throughCall("Bash", { command }, "plain output");
    assert.equal(out.content, "plain output", command);
    assert.deepEqual(out.toolUseResult, { stdout: "plain output" }, command);
    assert.equal(out.input.command, command);
  }
});

/** A session that says the value everywhere it can be said, and shows a dotenv file between. */
function sessionAround(dotenvCall: Record<string, unknown>[]) {
  const value = "Zq8vR2mK9xLp";
  const said = (uuid: string) => [
    { type: "user", uuid: `${uuid}-prompt`, message: { role: "user", content: `use ${value} for the mailer` } },
    { type: "assistant", uuid: `${uuid}-text`, message: { role: "assistant", content: [{ type: "text", text: `The phrase is ${value}.` }] } },
    { type: "assistant", uuid: `${uuid}-call`, message: { role: "assistant", content: [{ type: "tool_use", id: `${uuid}-t`, name: "Bash", input: { command: `node send.js ${value}` } }] } },
    { type: "user", uuid: `${uuid}-out`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${uuid}-t`, content: `sent with ${value}` }] }, toolUseResult: { stdout: `sent with ${value}` } },
  ];
  return { value, records: [...said("before"), ...dotenvCall, ...said("after")] };
}

const callAndResult = (name: string, input: Record<string, unknown>, output: unknown) => [
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "env", name, input }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "env", content: output }] }, toolUseResult: output },
];

test("a value a dotenv file showed goes from the whole session, before the read and after it", () => {
  const dotenv = "MAILER_PHRASE=Zq8vR2mK9xLp\nNODE_ENV=production\n";
  const ways: [string, Record<string, unknown>[]][] = [
    ["Read", callAndResult("Read", { file_path: "/repo/.env" }, `     1\u2192MAILER_PHRASE=Zq8vR2mK9xLp\n     2\u2192NODE_ENV=production\n`)],
    ["Read in blocks", callAndResult("Read", { file_path: "/repo/.env" }, [{ type: "text", text: dotenv }])],
    ["Grep", callAndResult("Grep", { pattern: "PHRASE", path: ".env", output_mode: "content" }, "MAILER_PHRASE=Zq8vR2mK9xLp")],
    ["cat", callAndResult("Bash", { command: "cat .env" }, dotenv)],
    ["node -e", callAndResult("Bash", { command: `node -e "console.log(fs.readFileSync('.env','utf8'))"` }, dotenv)],
    ["quoted", callAndResult("Bash", { command: "cat .env" }, `export MAILER_PHRASE="Zq8vR2mK9xLp"\n`)],
    ["cut, a value with no name", callAndResult("Bash", { command: "cut -d= -f2 .env" }, "Zq8vR2mK9xLp\nproduction\n")],
    ["Write", callAndResult("Write", { file_path: "/repo/.env", content: dotenv }, "ok")],
    ["Edit", callAndResult("Edit", { file_path: "/repo/.env", old_string: "x", new_string: dotenv }, "ok")],
    ["MultiEdit", callAndResult("MultiEdit", { file_path: "/repo/.env", edits: [{ old_string: "x", new_string: dotenv }] }, "ok")],
    ["echo into it", callAndResult("Bash", { command: `echo "MAILER_PHRASE=Zq8vR2mK9xLp" >> .env` }, "")],
    ["heredoc into it", callAndResult("Bash", { command: `cat > .env <<'EOF'\n${dotenv}EOF` }, "")],
    ["printf into it", callAndResult("Bash", { command: "printf 'MAILER_PHRASE=Zq8vR2mK9xLp\\nA=1\\n' > .env" }, "")],
    ["a ! command", [
      { type: "user", message: { role: "user", content: "<bash-input>cat .env</bash-input>" } },
      { type: "user", message: { role: "user", content: `<bash-stdout>${dotenv}</bash-stdout><bash-stderr></bash-stderr>` } },
    ]],
  ];
  for (const [way, call] of ways) {
    const { value, records } = sessionAround(call);
    const { lines, summary } = summaryFor(records);
    const out = lines.join("\n");
    assert.ok(!out.includes(value), `${way} left the value in the session`);
    assert.equal(out.split(marker("dotenv")).length - 1 >= 8, true, way);
    assert.ok((summary.counts.dotenv ?? 0) >= 8, way);
    const parsed = lines.map((line) => JSON.parse(line) as { message: { content: unknown } });
    assert.equal(parsed[0]!.message.content, `use ${marker("dotenv")} for the mailer`, way);
    const again = redactLines(lines);
    assert.deepEqual(again.lines, lines, `${way}: a second pass changes nothing`);
  }
});

test("a command that only names a dotenv file teaches nothing from its own text", () => {
  const value = "Zq8vR2mK9xLp";
  for (const command of [
    `python3 - <<'PY'\nMAILER_PHRASE="${value}"\nprint(open('.env').read())\nPY`,
    `MAILER_PHRASE=${value} node --env-file=.env send.js`,
  ]) {
    const { lines } = summaryFor([
      ...callAndResult("Bash", { command }, "plain output"),
      { type: "user", message: { role: "user", content: `use ${value} for the mailer` } },
    ]);
    assert.ok(lines.at(-1)!.includes(value), command);
  }
});

test("a value learned as a stream goes the same way", async () => {
  const { value, records } = sessionAround(callAndResult("Read", { file_path: "/repo/.env" }, "MAILER_PHRASE=Zq8vR2mK9xLp"));
  const stream = (async function* () {
    for (const record of records) yield JSON.stringify(record);
  })();
  const { lines } = await redactLineStream(stream);
  assert.ok(!lines.join("\n").includes(value));
  assert.equal(lines.length, records.length);
});

test("what a dotenv file holds in plain view does not shred the session", () => {
  const dotenv = [
    "NODE_ENV=production",
    "PORT=3000",
    "BASE_URL=http://localhost:3000",
    "API_URL=https://api.example.com/v1",
    "APP_DIR=/srv/app/current/release/public",
    "POSTGRES_PASSWORD=password",
    "ADMIN_PASSWORD=changeme",
    "DEBUG=true",
    "ROLE=assistant",
    "PAGE_TITLE=Transcript",
    "SHORT=Zq8vR2m",
    "ANTHROPIC_MODEL=claude-opus-5-5",
    "CHECKOUT_DIR=/repo/src/payments-module",
    "PIN_CODE=1234567890123",
    "CLIENT_REGION=eu-central-1",
    `const MARKER = "<!-- isy:comment:v1 -->";`,
  ].join("\n");
  const text = "In production the password is read at http://localhost:3000 and https://api.example.com/v1 for /srv/app/current/release/public, unless true: changeme, Transcript, Zq8vR2m, 3000, 1234567890123, claude-opus-5-5 in eu-central-1 under <!-- isy:comment:v1 -->.";
  const records = [
    { type: "user", uuid: "u1", sessionId: "s1", gitBranch: "claude-opus-5-5", cwd: "/repo", message: { role: "user", content: text } },
    { type: "assistant", uuid: "a1", sessionId: "s1", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/payments-module/a.ts", old_string: "a", new_string: "b" } }] } },
    ...callAndResult("Read", { file_path: "/repo/.env" }, dotenv),
  ];
  const { lines } = summaryFor(records);
  const parsed = lines.map((line) => JSON.parse(line) as { type: string; gitBranch?: string; message: { role: string; model?: string; content: { input: { file_path: string } }[] | string } });
  assert.equal(parsed[0]!.message.content, text);
  assert.equal(parsed[0]!.gitBranch, "claude-opus-5-5");
  assert.equal(parsed[1]!.type, "assistant");
  assert.equal(parsed[1]!.message.role, "assistant");
  assert.equal(parsed[1]!.message.model, "claude-opus-5-5");
  assert.equal((parsed[1]!.message.content as { input: { file_path: string } }[])[0]!.input.file_path, "src/payments-module/a.ts");
});

test("cuts what a shell command writes into a dotenv file, and what it printed", () => {
  const m = marker("dotenv");
  const cases: [string, string][] = [
    ["cat > .env << 'EOF'\nDB_PASS=Zq8vR2mK9xLp\nAPP_KEY=base64:Zq8vR2mK9xLpWq7=\nEOF", `${m} > .env`],
    ["python3 - <<'PY'\nopen('.env', 'w').write('DB_PASS=Zq8vR2mK9xLp')\nPY", `python3 - <<'PY'\n${m}\nPY`],
    ['echo "DB_PASS=Zq8vR2mK9xLp" > .env', `${m} > .env`],
    // The edit beside the write is still an edit.
    ["cd app && sed -i 's/a/b/' src/a.ts && printf 'DB_PASS=%s\\n' Zq8vR2mK9xLp >> config/.env.local", `cd app && sed -i 's/a/b/' src/a.ts && ${m} > config/.env.local`],
    ["echo DB_PASS=Zq8vR2mK9xLp | sudo tee -a .env", `${m} > .env`],
    ["Set-Content -Path .env -Value 'DB_PASS=Zq8vR2mK9xLp'", `${m} > .env`],
    // The values sit outside the statement that names the file.
    ["{ echo DB_PASS=Zq8vR2mK9xLp; echo APP=Zq8vR2mK9xLp; } > .env", `${m} > .env`],
    ["(echo DB_PASS=Zq8vR2mK9xLp; echo APP=Zq8vR2mK9xLp) | tee .env", `${m} > .env`],
    ["{\n  echo DB_PASS=Zq8vR2mK9xLp\n  echo APP=Zq8vR2mK9xLp\n} > .env", `${m} > .env`],
    ['echo "DB_PASS=Zq8vR2mK9xLp\nAPP=Zq8vR2mK9xLp" > .env', `${m} > .env`],
    // `tee` behind whatever runs it, and a target with a space in it.
    ["echo DB_PASS=Zq8vR2mK9xLp | sudo -u app tee .env", `${m} > .env`],
    ["echo DB_PASS=Zq8vR2mK9xLp | ssh host /usr/bin/tee app/.env", `${m} > app/.env`],
    ["'DB_PASS=Zq8vR2mK9xLp' | Tee-Object -FilePath .env", `${m} > .env`],
    ['echo "DB_PASS=Zq8vR2mK9xLp" > "My Projects/app/.env"', `${m} > My Projects/app/.env`],
    ["echo DB_PASS=Zq8vR2mK9xLp > my\\ app/.env", `${m} > my app/.env`],
    // A loop, a condition, a line that goes on in the next.
    ["for kv in DB_PASS=Zq8vR2mK9xLp APP=Zq8vR2mK9xLp; do echo $kv; done > .env", `${m} > .env`],
    ["if true; then echo DB_PASS=Zq8vR2mK9xLp; fi > .env", `${m} > .env`],
    ['echo "DB_PASS=Zq8vR2mK9xLp" \\\n  >> .env', `${m} > .env`],
    // The value sits where the write only names it.
    ['VALUE=Zq8vR2mK9xLp\necho "K=$VALUE" > .env', `${m} > .env`],
    ['VALUE=Zq8vR2mK9xLp; echo "K=$VALUE" > .env', `${m} > .env`],
    ['export VALUE=Zq8vR2mK9xLp && printf "K=%s" "${VALUE}" >> .env', `${m} > .env`],
    ['node -e "console.log(process.env.DB_PASS)" > env.txt', 'node -e "console.log(process.env.DB_PASS)" > env.txt'],
  ];
  // A variable the command does not set holds nothing the command could show.
  assert.equal(throughCall("Bash", { command: `cd app\necho "K=$FROM_ENV" > .env` }).input.command, `cd app\n${m} > .env`);
  for (const [command, expected] of cases) {
    const { lines } = summaryFor([
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "MAILER_PHRASE=Zq8vR2mK9xLp" }] },
        toolUseResult: { stdout: "MAILER_PHRASE=Zq8vR2mK9xLp", stderr: "", interrupted: false },
      },
    ]);
    const call = JSON.parse(lines[0]!) as { message: { content: { input: { command: string } }[] } };
    assert.equal(call.message.content[0]!.input.command, expected);
    assert.equal(lines[1]!.includes("Zq8vR2mK9xLp"), command === expected, command);
  }
});

test("a redirect or a tee inside a quoted argument writes nothing, unless the command runs that argument", () => {
  for (const command of [
    `echo "add this > .env"`,
    `echo 'then pipe it | tee .env'`,
    `printf 'a > .env\\n'`,
    `git commit -m "stop writing > .env from the hook"`,
    `git commit -m 'stop piping | tee .env'`,
    `grep -n "> .env" deploy.sh`,
    `gh pr comment 1 --body "write > .env first"`,
  ]) {
    assert.equal(throughCall("Bash", { command }, "plain output").input.command, command);
  }

  const m = marker("dotenv");
  const cases: [string, string][] = [
    [`echo "K=Zq8vR2mK9xLp > x" > .env`, `${m} > .env`],
    [`echo "K=Zq8vR2mK9xLp" > ".env"`, `${m} > .env`],
    [`echo "K=Zq8vR2mK9xLp" | tee .env`, `${m} > .env`],
    [`sudo sh -c 'echo K=Zq8vR2mK9xLp >> .env'`, `${m} > .env`],
    [`bash -c "echo K=Zq8vR2mK9xLp > .env"`, `${m} > .env`],
    [`ssh host "echo K=Zq8vR2mK9xLp > /app/.env"`, `${m} > /app/.env`],
  ];
  for (const [command, expected] of cases) {
    assert.equal(throughCall("Bash", { command }).input.command, expected);
  }
});

test("a here-string is no heredoc: the line after it is not its body", () => {
  const read = "tr a b <<< hello\ncat .env";
  assert.equal(throughCall("Bash", { command: read }).input.command, read);
  assert.equal(throughCall("Bash", { command: read }).content, marker("dotenv"));
  assert.equal(
    throughCall("Bash", { command: "tr a b <<< hello\necho K=Zq8vR2mK9xLp > .env" }).input.command,
    `tr a b <<< hello\n${marker("dotenv")} > .env`,
  );
});

test("a background command's task goes the way of the command", () => {
  const value = "Zq8vR2mK9xLp";
  const command = `echo MAILER_PHRASE=${value} > .env; sleep 100`;
  const started = (id: string, task: string, run: string) => [
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: run, run_in_background: true } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `running as ${task}` }] }, toolUseResult: { backgroundTaskId: task } },
  ];
  const followed = (id: string, name: string, input: Record<string, unknown>, run: string) => [
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `stopped ${run}` }] }, toolUseResult: { message: "stopped", command: run, task_id: "any", task_type: "local_bash" } },
  ];
  const { lines } = summaryFor([
    ...started("t1", "bg1", command),
    ...followed("t2", "TaskStop", { task_id: "bg1" }, command),
    ...followed("t3", "TaskOutput", { task_id: "bg1" }, command),
    ...followed("t4", "BashOutput", { bash_id: "bg1" }, command),
    ...followed("t5", "KillShell", { shell_id: "bg1" }, command),
    ...started("t6", "bg2", "npm run dev"),
    ...followed("t7", "TaskStop", { task_id: "bg2" }, "npm run dev"),
  ]);
  const out = lines.map((line) => JSON.parse(line) as { message: { content: { content: string }[] }; toolUseResult: unknown });
  for (const i of [3, 5, 7, 9]) {
    assert.equal(out[i]!.message.content[0]!.content, marker("dotenv"));
    assert.equal(out[i]!.toolUseResult, marker("dotenv"));
  }
  assert.equal(out[13]!.message.content[0]!.content, "stopped npm run dev");
  assert.ok(!lines.join("\n").includes(value));
});

test("an in-place edit of a dotenv file loses its script, and stays an edit", () => {
  const m = marker("dotenv");
  const cases: [string, string, string][] = [
    ["sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i.bak 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' config/.env.local", `sed -i ${m} config/.env.local`, "config/.env.local"],
    ["sed -i -e 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    ["perl -pi -e 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    ["cd app && sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env && npm test", `cd app && sed -i ${m} .env && npm test`, "app/.env"],
  ];
  for (const [command, expected, path] of cases) {
    const out = throughCall("Bash", { command, description: "set the key" });
    assert.equal(out.input.command, expected);
    assert.equal(out.content, m, command);
    assert.deepEqual(shellEditPaths(expected, "."), [path]);
  }
  const { lines } = summaryFor([
    ...callAndResult("Bash", { command: "sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env" }, ""),
    { type: "user", message: { role: "user", content: "the key is Zq8vR2mK9xLp" } },
  ]);
  assert.ok(!lines.join("\n").includes("Zq8vR2mK9xLp"), "and the value it set goes from the session");

  const kept = "sed -i 's/a/b/' src/env.ts";
  assert.equal(throughCall("Bash", { command: kept }, "plain output").input.command, kept);
});

test("cuts what a ! command typed in Claude Code printed from a dotenv file, or wrote into one", () => {
  const turn = (content: string) => ({ type: "user", message: { role: "user", content } });
  const { lines } = summaryFor([
    turn("<bash-input>cat .env</bash-input>"),
    turn("<bash-stdout>DB_PASS=Zq8vR2mK9xLp</bash-stdout><bash-stderr></bash-stderr>"),
    turn("<bash-input>echo DB_PASS=Zq8vR2mK9xLp | tee .env</bash-input>"),
    turn("<bash-stdout>DB_PASS=Zq8vR2mK9xLp</bash-stdout><bash-stderr></bash-stderr>"),
    turn("<bash-input>ls</bash-input>"),
    turn("<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>"),
  ]);
  const content = lines.map((line) => (JSON.parse(line) as { message: { content: string } }).message.content);
  assert.deepEqual(content, [
    "<bash-input>cat .env</bash-input>",
    marker("dotenv"),
    `<bash-input>${marker("dotenv")} > .env</bash-input>`,
    marker("dotenv"),
    "<bash-input>ls</bash-input>",
    "<bash-stdout>README.md</bash-stdout><bash-stderr></bash-stderr>",
  ]);
});

test("cuts the result of a search on a dotenv file, whichever argument names the file", () => {
  const cut: [string, Record<string, unknown>][] = [
    ["Grep", { pattern: "PHRASE", path: ".env", output_mode: "content" }],
    ["Grep", { pattern: "PHRASE", path: "/repo/.env", output_mode: "content" }],
    ["Grep", { pattern: "PHRASE", path: "config/.env.local", output_mode: "content" }],
    ...[".env*", "**/.env*", "{.env,.env.local}", "*.env", "config/.env.*"].map((glob): [string, Record<string, unknown>] => ["Grep", { pattern: "PHRASE", glob, output_mode: "content" }]),
    ["mcp__fs__read_file", { path: ".env" }],
    ["mcp__fs__read_multiple_files", { paths: ["README.md", "app/.env.local"] }],
    ["mcp__serena__read_file", { relative_path: ".env" }],
  ];
  for (const [name, input] of cut) {
    const out = throughCall(name, input);
    assert.equal(out.content, marker("dotenv"), JSON.stringify(input));
    assert.equal(out.toolUseResult, marker("dotenv"), JSON.stringify(input));
    assert.deepEqual(out.input, input, "the call itself names the file, not what is in it");
  }

  const kept: [string, Record<string, unknown>][] = [
    ["Grep", { pattern: "\\.env", path: "src", output_mode: "content" }],
    ["Grep", { pattern: "process.env", glob: "*.ts", output_mode: "content" }],
    ["Glob", { pattern: "**/.env*" }],
    ["mcp__fs__read_file", { path: "README.md" }],
    ["Agent", { prompt: "read .env and report", description: "look at .env" }],
  ];
  for (const [name, input] of kept) {
    assert.equal(throughCall(name, input, "plain output").content, "plain output", JSON.stringify(input));
  }
});

test("a write through any tool that names a dotenv file loses what it writes", () => {
  const out = throughCall("mcp__fs__write_file", { path: "app/.env", content: "MAILER_PHRASE=Zq8vR2mK9xLp" });
  assert.deepEqual(out.input, { path: "app/.env", content: marker("dotenv") });
});

test("a multi-edit on a dotenv file loses every step's strings, and its steps stay edits", () => {
  const edits = [
    { old_string: "MAILER_PHRASE=old1234567890", new_string: "MAILER_PHRASE=Zq8vR2mK9xLp" },
    { old_string: "OTHER=old1234567890", new_string: "OTHER=Zq8vR2mK9xLp", replace_all: true },
  ];
  const record = { type: "assistant", uuid: "a", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "MultiEdit", input: { file_path: "/repo/.env", edits } }] } };
  const { lines } = summaryFor([record]);
  const m = marker("dotenv");
  const call = JSON.parse(lines[0]!) as typeof record;
  assert.deepEqual(call.message.content[0]!.input.edits, [
    { old_string: m, new_string: m },
    { old_string: m, new_string: m, replace_all: true },
  ]);
  assert.equal(parseLines(lines).fileEdits.get("/repo/.env")?.length, 2);
});

test("leaves a tool_result alone when the file is not a dotenv file", () => {
  const { lines } = summaryFor([
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/readme.md" } }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "plain docs" }] },
    },
  ]);

  const result = JSON.parse(lines[1]!) as { message: { content: { content: string }[] } };
  assert.equal(result.message.content[0]?.content, "plain docs");
});

test("applies extra patterns from configuration", () => {
  const out = redactOne("internal ACME-9F3K2 reference", ["ACME-[A-Z0-9]{5}"]);
  assert.equal(out, `internal ${marker("custom")} reference`);
});

test("reports an invalid extra pattern instead of throwing", () => {
  const { summary } = redactLines([JSON.stringify({ type: "user" })], { extraPatterns: ["([unclosed"] });
  assert.deepEqual(summary.invalidExtraPatterns, ["([unclosed"]);
});

test("redacts a line that is not valid JSON without dropping it", () => {
  const { lines, summary } = redactLines(["not json at all sk-abcdefghij0123456789XYZ"]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `not json at all ${marker("openai_key")}`);
  assert.equal(summary.unparsedLines, 1);
});

test("a record with U+2028 in a string is read whole, and its key-named secret redacted", async () => {
  // JSON.stringify leaves U+2028 and U+2029 unescaped; node:readline ends a
  // line at both, and the record came apart into two fragments.
  const dir = await mkdtemp(join(tmpdir(), "isy-redact-"));
  const file = join(dir, "session.jsonl");
  const record = { type: "user", toolUseResult: { stdout: "one\u2028two\u2029three", token: "abcdefgh12345678" } };
  await writeFile(file, `${JSON.stringify({ type: "user" })}\r\n${JSON.stringify(record)}\n`);

  const { lines, summary } = await redactTranscriptFile(file);
  assert.equal(lines.length, 2);
  assert.equal(summary.unparsedLines, 0);
  assert.ok(!lines[1]!.includes("abcdefgh12345678"));
  assert.equal((JSON.parse(lines[1]!) as typeof record).toolUseResult.stdout, "one\u2028two\u2029three");

  const session = await parseTranscriptFile(file);
  assert.equal(session.records.length, 2);
  assert.equal(session.skipped.malformedJson, 0);
  await rm(dir, { recursive: true, force: true });
});

test("masks email addresses", () => {
  assert.equal(redactOne("Author: Alice <alice.b+isy@mail.example.org>"), `Author: Alice <${marker("email")}>`);
  // Not an address: no domain, or a version where the domain would be.
  assert.equal(redactOne("@nightloom/isy@1.0.1 and @scope/pkg"), "@nightloom/isy@1.0.1 and @scope/pkg");
});

test("an attachment record keeps its place in the chain and loses everything but its type", () => {
  // What Claude Code 2.1.285 writes as context for the model: the account's
  // email, its organisation, the system prompt.
  const records = [
    { type: "attachment", uuid: "a1", parentUuid: null, attachment: { type: "session_context", context: { userEmail: "The user's email address is alice@example.org." } }, rendered: [{ content: "alice@example.org" }], renderedRole: "user" },
    { type: "attachment", uuid: "a2", parentUuid: "a1", attachment: { type: "credential_org", organizationUuid: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" } },
    { type: "attachment", uuid: "a3", parentUuid: "a2", attachment: { type: "prompt_snapshot", systemPrompt: "You are Claude Code. # claudeMd ..." } },
  ];
  const { lines } = summaryFor(records);
  const out = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(out, [
    { type: "attachment", uuid: "a1", parentUuid: null, attachment: { type: "session_context" } },
    { type: "attachment", uuid: "a2", parentUuid: "a1", attachment: { type: "credential_org" } },
    { type: "attachment", uuid: "a3", parentUuid: "a2", attachment: { type: "prompt_snapshot" } },
  ]);
});

test("a recorded request keeps only the fields that name it", () => {
  // What Claude Code 2.1.312 writes beside each API call.
  const records = [
    { type: "api-request-shape", sessionId: "s1", shapeHash: "h1", timestamp: "2026-10-29T20:00:00.000Z", version: "2.1.312", shape: { system: [{ type: "text", text: "You are Claude Code. # claudeMd ..." }], tools: [{ name: "Bash", description: "..." }] } },
    { type: "api-request-blob", sessionId: "s1", hash: "h2", message: { role: "user", content: [{ type: "text", text: "The user's email address is alice@example.org." }] } },
    { type: "api-request", sessionId: "s1", id: "r1", timestamp: "2026-10-29T20:00:01.000Z", version: "2.1.312", shapeHash: "h1", params: { model: "claude-opus-5-5", max_tokens: 64000, safeguards: [{ type: "classifier", classifier_context: "User: alice. Home: /home/alice. Allow: Bash(npm test)" }] }, tail: ["h2"] },
  ];
  const { lines } = summaryFor(records);
  const out = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(out, [
    { type: "api-request-shape", sessionId: "s1", shapeHash: "h1", timestamp: "2026-10-29T20:00:00.000Z", version: "2.1.312" },
    { type: "api-request-blob", sessionId: "s1", hash: "h2" },
    { type: "api-request", sessionId: "s1", timestamp: "2026-10-29T20:00:01.000Z", version: "2.1.312", shapeHash: "h1" },
  ]);
});

test("a subagent's recorded request still reads as the subagent's", () => {
  const { lines } = summaryFor([
    { type: "api-request", sessionId: "s1", agentId: "a1b2", isSidechain: true, parentToolUseID: "toolu_1", params: { model: "claude-opus-5-5" } },
  ]);
  assert.deepEqual(JSON.parse(lines[0]!), { type: "api-request", sessionId: "s1", agentId: "a1b2", isSidechain: true, parentToolUseID: "toolu_1" });
});

test("bridge and artifact records go up without the account and organisation they name", () => {
  // What Claude Code 2.1.312 writes for the session's bridge and its artifacts.
  const records = [
    { type: "bridge-session", sessionId: "s1", bridgeSessionId: "b1", lastSequenceNum: 3, ownerAccountUuid: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", ownerOrganizationUuid: "6fa459ea-ee8a-3ca4-894e-db77e160355e" },
    { type: "artifact-autoreact-ledger", sessionId: "s1", v: 1, accountUuid: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", artifacts: {} },
  ];
  const { lines } = summaryFor(records);

  assert.deepEqual(lines.map((line) => JSON.parse(line) as Record<string, unknown>), [
    { type: "bridge-session", sessionId: "s1" },
    { type: "artifact-autoreact-ledger", sessionId: "s1" },
  ]);
});

test("a turn loses the harness fields beside it, and a dotenv write its second copy", () => {
  // What Claude Code 2.1.31x writes beside a call and beside its result.
  const write = { file_path: "/repo/.env", content: "STRIPE_LIVE=pk_live_totally_real" };
  const records = [
    {
      type: "assistant",
      uuid: "a",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Write", input: write }] },
      wireToolInputs: { t1: write },
      wireIngestContext: { t1: { cwd: "/repo" } },
      serverClassifierRequest: "User: alice. Write /repo/.env",
    },
    {
      type: "user",
      uuid: "b",
      parentUuid: "a",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      serverClassifierContext: { request: "Write", context: { git_state: { cwd: "/repo", branch: "main" }, live_cwd: "/repo", platform: "linux" } },
      permissionDecision: { decision: "allow", source: "rule", reasonType: "rule" },
    },
  ];
  const { lines } = summaryFor(records);
  const out = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(Object.keys(out[0]!), ["type", "uuid", "message"]);
  assert.deepEqual(Object.keys(out[1]!), ["type", "uuid", "parentUuid", "message"]);
  assert.ok(!lines[0]!.includes("pk_live_totally_real"));
});

test("a harness message in the user's place keeps its place in the chain and loses its text", () => {
  // What Claude Code writes after `/review`: the developer's command, then the
  // skill's body and a reminder as `isMeta` user records.
  const records = [
    { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "<command-name>/review</command-name>\n<command-args>src/a.ts</command-args>" } },
    { type: "user", uuid: "u2", parentUuid: "u1", isMeta: true, sourceToolUseID: "t1", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /home/alice/.claude/skills/review\n# Review\nRead every file..." }] } },
    { type: "user", uuid: "u3", parentUuid: "u2", isMeta: true, message: { role: "user", content: "<system-reminder>The user's email address is alice@example.org.</system-reminder>" } },
    { type: "assistant", uuid: "a1", parentUuid: "u3", message: { role: "assistant", content: [{ type: "text", text: "Reviewing." }] } },
  ];
  const { lines } = summaryFor(records);
  const out = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.deepEqual(out[0], records[0]);
  assert.deepEqual(out[1], { ...records[1], message: { role: "user", content: marker("meta") } });
  assert.deepEqual(out[2], { ...records[2], message: { role: "user", content: marker("meta") } });
  assert.deepEqual(out[3], records[3]);
  assert.deepEqual([...parseLines(lines).mainPath], ["a1", "u3", "u2", "u1"]);
});

test("the server can re-run the rules over a stored transcript, with no roots of its own", async () => {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
  assert.equal(pkg.exports["./redact"], "./dist/redact.js");

  // Uploaded by an older client: its paths already masked, a key it did not know.
  const stored = JSON.stringify({ type: "user", cwd: ".", message: { role: "user", content: `deploy sk_live_${"a1".repeat(12)} from /root/app, ~/x and src/a.ts` } });
  const expected = `deploy ${marker("stripe_key")} from /root/app, ~/x and src/a.ts`;
  for (const options of [undefined, { home: "" }]) {
    const { lines } = redactLines([stored], options);
    assert.equal((JSON.parse(lines[0]!) as { message: { content: string } }).message.content, expected);
  }
});

test("keeps output parseable as JSONL and counts what it replaced", () => {
  const { lines, summary } = summaryFor([
    { type: "user", message: { role: "user", content: 'password = "hunter2000"' } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `AIza${"x".repeat(35)}` }] } },
  ]);

  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(summary.counts.assignment, 1);
  assert.equal(summary.counts.google_key, 1);
  assert.equal(summary.replacements, 2);
  assert.equal(summary.lines, 2);
});

test("every builtin rule replaces with the shared marker prefix", () => {
  for (const rule of BUILTIN_RULES) {
    assert.ok(rule.replacement.includes(REDACTION_MARKER), `${rule.type} lacks the marker`);
    assert.ok(rule.pattern.global, `${rule.type} must be a global pattern`);
  }
});

test("masks absolute paths in a record, learning the root from the record itself", () => {
  const record = {
    type: "assistant",
    cwd: "/home/alice/work/isy",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Edit", input: { file_path: "/home/alice/work/isy/src/a.ts" } },
        { type: "tool_use", name: "Bash", input: { command: "cd /home/alice/work/isy && npm test" } },
      ],
    },
  };

  const { lines, summary } = redactLines([JSON.stringify(record)]);
  const parsed = JSON.parse(lines[0]!) as typeof record;

  // The working directory is the one thing every record repeats, so it is the
  // root even when the hook did not say where the session ran.
  assert.equal(parsed.cwd, ".");
  assert.equal((parsed.message.content[0] as { input: { file_path: string } }).input.file_path, "src/a.ts");
  assert.equal(
    (parsed.message.content[1] as { input: { command: string } }).input.command,
    "cd . && npm test",
  );
  assert.ok((summary.counts.path ?? 0) >= 3);
});

test("masks a path carried as a JSON object key", () => {
  // Claude Code keys its per-file state by absolute path. Redaction walked the
  // values only, so the account name stayed in the key of every such map.
  const record = {
    type: "assistant",
    cwd: "/home/alice/work/isy",
    toolUseResult: {
      "/home/alice/work/isy/src/a.ts": { readAt: 1 },
      "/home/alice/.claude/settings.json": { readAt: 2 },
    },
  };

  const { lines } = redactLines([JSON.stringify(record)]);
  const parsed = JSON.parse(lines[0]!) as { toolUseResult: Record<string, unknown> };

  assert.deepEqual(Object.keys(parsed.toolUseResult), ["src/a.ts", "~/.claude/settings.json"]);
});

test("the working directory the caller names wins over the one on the record", () => {
  const record = { type: "user", cwd: "/home/alice/elsewhere", message: { role: "user", content: "/home/alice/work/isy/src/a.ts" } };
  const { lines } = redactLines([JSON.stringify(record)], { cwd: "/home/alice/work/isy" });
  const parsed = JSON.parse(lines[0]!) as { message: { content: string } };
  assert.equal(parsed.message.content, "src/a.ts");
});

test("a stored transcript's relative working directory is no root to learn", () => {
  // Masked on the client: the session started in `src`, and these are other files.
  const content = "cat ./src/a.ts ../src/b.ts /src/c.ts";
  const stored = JSON.stringify({ type: "user", cwd: "src", message: { role: "user", content } });
  const { lines } = redactLines([stored], { home: "" });
  const parsed = JSON.parse(lines[0]!) as { cwd: string; message: { content: string } };
  assert.equal(parsed.message.content, content);
  assert.equal(parsed.cwd, "src");
});

test("a relative name in a path field is read from where the session stood", () => {
  const input = {
    file_path: "src/a.ts",
    path: "../test/b.ts",
    file: "/home/alice/repo/pkg/c.ts",
    notebook_path: "~/notes.ipynb",
    filePath: "https://example.com/d.ts",
    command: "cat src/a.ts",
  };
  const stored = JSON.stringify({ type: "assistant", cwd: "/home/alice/repo/pkg", message: { content: [{ type: "tool_use", input }] } });
  const options = { cwd: "/home/alice/repo", base: "/home/alice/repo/pkg" };
  const { lines } = redactLines([stored], options);
  const parsed = JSON.parse(lines[0]!) as { cwd: string; message: { content: { input: typeof input }[] } };

  assert.equal(parsed.cwd, "pkg");
  assert.deepEqual(parsed.message.content[0]!.input, {
    file_path: "pkg/src/a.ts",
    path: "test/b.ts",
    file: "pkg/c.ts",
    notebook_path: "~/notes.ipynb",
    filePath: "https://example.com/d.ts",
    command: "cat src/a.ts",
  });

  // Standing at the root there is nothing to read them from: left as they were typed.
  const atRoot = redactLines([stored], { cwd: "/home/alice/repo" });
  const typed = JSON.parse(atRoot.lines[0]!) as typeof parsed;
  assert.equal(typed.message.content[0]!.input.file_path, "src/a.ts");
});

test("masks a home path in a transcript that never says where it ran", () => {
  const out = redactOne("failed to open /Users/dave/Library/Caches/pnpm/store");
  assert.equal(out, "failed to open ~/Library/Caches/pnpm/store");
});

test("a secret and a path in one string do not interfere", () => {
  const out = redactOne("wrote sk-abcdefghij0123456789XYZ to /home/alice/.netrc");
  assert.equal(out, `wrote ${marker("openai_key")} to ~/.netrc`);
});

test("leaves ordinary source code untouched", () => {
  const code = "const total = items.reduce((sum, item) => sum + item.price, 0);";
  assert.equal(applyRules(code, BUILTIN_RULES), code);
});

const corpus = join(homedir(), ".claude", "projects");

test("redacts real transcripts without corrupting them", { skip: !existsSync(corpus) }, async () => {
  const projects = await readdir(corpus);
  const files: string[] = [];

  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(corpus, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(corpus, project, entry));
    }
  }

  assert.ok(files.length > 0);

  let redactedLines = 0;
  for (const file of files) {
    const { lines, summary } = await redactTranscriptFile(file);
    redactedLines += lines.length;
    assert.equal(summary.invalidExtraPatterns.length, 0);
    // A line that came in broken — a transcript cut off mid-write — goes out
    // broken and is counted; every other one has to come out as JSON.
    const broken = lines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    assert.ok(broken.length <= summary.unparsedLines, `${file} produced invalid JSON`);
  }

  assert.ok(redactedLines > 0);
});

test("redacted output still parses into the same session structure", { skip: !existsSync(corpus) }, async (t) => {
  const projects = await readdir(corpus);
  // Both parses read one copy: a session still being written grows between two
  // reads of its file, and the counts would differ for no fault of redaction.
  const scratch = await mkdtemp(join(tmpdir(), "isy-structure-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const file = join(scratch, "session.jsonl");
  let checked = 0;

  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(corpus, project));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const source = join(corpus, project, entry);
      await copyFile(source, file);

      const original = await parseTranscriptFile(file);
      const { lines } = await redactTranscriptFile(file);
      const redacted = parseLines(lines);

      assert.equal(redacted.records.length, original.records.length, `${source} lost records`);
      assert.equal(redacted.toolUses.length, original.toolUses.length, `${source} lost tool calls`);
      // Edits, not files: a `sed -i` path is resolved from the command's text,
      // which masking rewrites, so two keys for one file can become one.
      const edits = (session: typeof original) => [...session.fileEdits.values()].reduce((sum, list) => sum + list.length, 0);
      assert.equal(edits(redacted), edits(original), `${source} lost edits`);
      assert.equal(redacted.mainPath.size, original.mainPath.size, `${source} lost tree structure`);
      checked += 1;
    }
  }

  assert.ok(checked > 0);
});

test("every rule gets through long runs it has nothing to match in", () => {
  // Shapes a tool's output holds by the hundred kilobytes: a version list, a
  // URL-encoded query, dotted and dashed names. A rule that rescans the rest of
  // the run from every boundary in it takes minutes over one transcript.
  const shapes = ["1.".repeat(50_000), "%2F".repeat(35_000), "a.".repeat(50_000), "ab-".repeat(35_000)];
  for (const text of shapes) {
    for (const rule of BUILTIN_RULES) {
      const started = performance.now();
      applyRules(text, [rule]);
      const took = performance.now() - started;
      assert.ok(took < 1000, `${rule.type} took ${Math.round(took)}ms on ${text.slice(0, 6)}…`);
    }
  }
});

test("every rule gets through text shaped almost like what it matches", () => {
  const fill = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length));
  const shapes = [
    fill("--password "),
    fill("--password-"),
    `--password${" ".repeat(200_000)}`,
    `--password ${"a".repeat(200_000)}"`,
    fill("curl "),
    fill("curl -u "),
    fill("curl -u a "),
    `curl -u ${"a".repeat(200_000)}`,
    `curl -u ${" ".repeat(200_000)}`,
    fill("curl --user "),
    fill("mysql "),
    fill("mysql -p "),
    fill("sshpass "),
    fill("sshpass -p "),
    fill("docker login "),
    fill("redis-cli -a "),
    fill("bearer "),
    `bearer ${"a".repeat(200_000)}`,
    `bearer ${" ".repeat(200_000)}`,
    fill("bearer a."),
    fill("authorization: "),
    fill("authorization:"),
    fill("authorization: a "),
    `authorization:${" ".repeat(200_000)}`,
    `authorization: a${" ".repeat(200_000)}`,
    `authorization: ${"a".repeat(200_000)}`,
    `authorization: ${"a-".repeat(100_000)}`,
    fill("cookie: "),
    fill('cookie: "'),
    fill("cookie: <"),
    `cookie:${" ".repeat(200_000)}`,
    `cookie: ${"a".repeat(200_000)}`,
    fill("pass"),
    fill("_pass_"),
    fill("aPass"),
    fill("byPass"),
    fill("_pwd"),
    fill("auth-"),
    fill("cookie."),
    fill("PASSWORD=a$"),
    fill("PASSWORD=a("),
    fill("password=aaaaaaaa("),
    fill("password=aaaaaaaa()"),
    fill("password=a.b("),
    fill("password='"),
    fill("password='$"),
    `PASSWORD=${"a$".repeat(100_000)}`,
    `PASSWORD=${"(".repeat(200_000)}`,
    `PASSWORD=a${"(".repeat(200_000)}`,
    `password=${"a".repeat(200_000)}(`,
    `password=${"a.".repeat(100_000)}`,
    `password=a(${"b".repeat(200_000)}`,
  ];
  for (const text of shapes) {
    for (const rule of BUILTIN_RULES) {
      const started = performance.now();
      applyRules(text, [rule]);
      const took = performance.now() - started;
      assert.ok(took < 1000, `${rule.pattern.source.slice(0, 30)} took ${Math.round(took)}ms on ${text.slice(0, 12)}…`);
    }
  }
});

test("cutting a write to a dotenv file gets through what looks almost like one", () => {
  const fill = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length));
  const shapes = [
    `${fill("$a")} > .env`,
    `${fill("a=")} $a > .env`,
    `${Array.from({ length: 30_000 }, (_, i) => `$a${i}`).join("")} > .env`,
    `${Array.from({ length: 30_000 }, (_, i) => `a${i}=`).join("")} $b > .env`,
    `echo ${fill('\\"')} > .env`,
    `echo "${fill('\\"')} > .env`,
    `echo ${fill("'")} > .env`,
    `echo ${fill('"')} > .env`,
    `echo ${fill('"\\')} > .env`,
    `echo ${fill('> "')} .env`,
    `echo ${fill("> a'")} .env`,
    `echo ${fill(">")} .env`,
    `echo >${" ".repeat(200_000)}.env`,
    `echo ${fill("> ")}.env`,
    `tee ${fill("a ")} .env`,
    `${fill("<<<")} .env`,
    `${fill("<<")} .env`,
    `${fill("<<a ")}\n.env`,
    `<<${" ".repeat(200_000)}.env`,
  ];
  for (const command of shapes) {
    const started = performance.now();
    const { lines } = redactLines([JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } })]);
    const took = performance.now() - started;
    assert.equal(lines.length, 1);
    assert.ok(took < 5000, `took ${Math.round(took)}ms on ${command.slice(0, 12)}…`);
  }
});

test("learning a dotenv file's values gets through what looks almost like one", () => {
  const fill = (unit: string) => unit.repeat(Math.ceil(200_000 / unit.length));
  const shapes = [
    fill("A="),
    fill('A="'),
    fill("A='"),
    fill(`A="B='`),
    `A=${" ".repeat(200_000)}`,
    `A${" ".repeat(200_000)}`,
    `A="${"b".repeat(200_000)}`,
    fill("a b "),
    fill("="),
    fill("a="),
    fill("\\n"),
    `${"a".repeat(200_000)}=`,
    `${"a".repeat(100_000)}${"=".repeat(100_000)}b`,
    fill("KEY=Zq8vR2mK9xLp\n"),
    Array.from({ length: 9_000 }, (_, i) => `KEY=Zq8vR2mK9xLp${i}\n`).join(""),
  ];
  for (const text of shapes) {
    const started = performance.now();
    const { lines } = redactLines([
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: ".env" } }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: text } }),
    ]);
    const took = performance.now() - started;
    assert.equal(lines.length, 3);
    assert.ok(took < 5000, `took ${Math.round(took)}ms on ${text.slice(0, 12)}…`);
  }
});

test("an email or a URL password is still caught where the run it sits in starts with punctuation", () => {
  const out = applyRules("mail -alice@example.com; db=-x.postgres://u:hunter22@db.local/app", BUILTIN_RULES);
  assert.ok(!out.includes("alice@example.com"));
  assert.ok(!out.includes("hunter22"));
});
