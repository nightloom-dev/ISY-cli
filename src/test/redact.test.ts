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

test("masks a token by the prefix its service issues it under", () => {
  const body = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6a7B8c9D0e1F2";
  const hex = "0123456789abcdef".repeat(4);
  const m = marker("service_token");
  const tokens = [
    `glpat-${body.slice(0, 20)}`,
    `gldt-${body.slice(0, 20)}`,
    `xapp-1-A0123456789-1234567890123-${hex}`,
    `hooks.slack.com/services/T00000000/B00000000/${body.slice(0, 24)}`,
    `discord.com/api/webhooks/123456789012345678/${body}`,
    `discordapp.com/api/webhooks/123456789012345678/${body}`,
    `gsk_${body.slice(0, 52)}`,
    `xai-${body}`,
    `ya29.${body}`,
    `1//0${body}`,
    `whsec_${body.slice(0, 32)}`,
    `SG.${body.slice(0, 22)}.${body.slice(0, 43)}`,
    `key-${hex.slice(0, 32)}`,
    `SK${hex.slice(0, 32)}`,
    `shpat_${hex.slice(0, 32)}`,
    `shpss_${hex.slice(0, 32)}`,
    `dop_v1_${hex}`,
    `hf_${body.slice(0, 34)}`,
    `pypi-${body}`,
    `rubygems_${hex.slice(0, 48)}`,
    `dckr_pat_${body.slice(0, 27)}`,
    `sbp_${hex.slice(0, 40)}`,
    `vercel_${body.slice(0, 24)}`,
    `ATATT3xFfGF0${body}`,
    `lin_api_${body.slice(0, 40)}`,
    `ntn_${body.slice(0, 46)}`,
    `secret_${body.slice(0, 43)}`,
    `figd_${body.slice(0, 40)}`,
    `r8_${body.slice(0, 37)}`,
    `sk_${hex.slice(0, 48)}`,
    `AGE-SECRET-KEY-1${body.slice(0, 58).toUpperCase()}`,
  ];
  for (const token of tokens) {
    const said = `your new key is ${token} (save it)`;
    assert.equal(redactOne(said), `your new key is ${m} (save it)`);
    assert.equal(redactOne(`your new key is ${m} (save it)`), `your new key is ${m} (save it)`, "a second pass changes nothing");
  }
  assert.equal(redactOne(`ghr_${body.slice(0, 36)}`), marker("github_token"));
  // What is left is an id, which is public: a fal.ai key's, a Telegram bot's, a Discord bot's in base64.
  for (const [id, rest] of [
    ["12345678-1234-4123-8123-123456789abc", `:${hex.slice(0, 32)}`],
    ["1234567890", `:AA${body.slice(0, 33)}`],
    [body.slice(0, 24), `.${body.slice(0, 6)}.${body.slice(0, 38)}`],
  ] as const) {
    assert.equal(redactOne(`token ${id}${rest} here`), `token ${id}${m} here`);
  }

  for (const text of [
    "hf_model_name",
    "gsk_short",
    "glob-pattern-with-a-very-long-name-here",
    "key-value",
    "key-0123456789",
    "monkey-0123456789abcdef0123456789abcdef",
    "secret_santa",
    "vercel_deployment_configuration_file",
    "r8_format",
    "SG.example.com",
    "see 1//comment here",
    "ATATT",
    "the-settings-page-component-a.module.the-settings-page-component-styles",
    "123e4567-e89b-12d3-a456-426614174000",
  ]) {
    assert.equal(redactOne(text), text);
  }
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
  assert.equal(redactOne("REDIS_URL=redis://:hunter2000@localhost:6379/0"), `REDIS_URL=redis://:${masked}@localhost:6379/0`);
  assert.equal(redactOne("redis-cli -u redis://:hunter2000@localhost:6379 ping"), `redis-cli -u redis://:${masked}@localhost:6379 ping`);
  assert.equal(redactOne("amqp://:hunter2000@mq/"), `amqp://:${masked}@mq/`);
  assert.equal(redactOne(`redis://:${masked}@localhost:6379/0`), `redis://:${masked}@localhost:6379/0`, "a second pass changes nothing");
  // A port is not a password: nothing in this URL is masked.
  assert.equal(redactOne("https://example.com:8080/a/@scope/pkg"), "https://example.com:8080/a/@scope/pkg");
  assert.equal(redactOne("https://:8080/a/@scope/pkg"), "https://:8080/a/@scope/pkg");

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
    // Short flags run together.
    ["curl -ku admin:hunter2000 https://x", `curl -ku admin:${m} https://x`],
    ["curl -sSu admin:hunter2000 https://x", `curl -sSu admin:${m} https://x`],
    ["curl -fsSLu admin:hunter2000 https://x", `curl -fsSLu admin:${m} https://x`],
    ["curl -sSuadmin:hunter2000 https://x", `curl -sSuadmin:${m} https://x`],
    ["curl -kU proxy:hunter2000 https://x", `curl -kU proxy:${m} https://x`],
    // A quoted value runs to its closing quote, spaces and the other quote included.
    ["curl -u 'admin:pa ss wo rd' https://x", `curl -u 'admin:${m}' https://x`],
    [`curl -u "admin:it's a pa ss" https://x`, `curl -u "admin:${m}" https://x`],
    ["curl --user 'admin:pa ss wo rd' https://x", `curl --user 'admin:${m}' https://x`],
    ["curl -ku 'admin:pa ss wo rd' https://x", `curl -ku 'admin:${m}' https://x`],
    ["curl -u admin:'pa ss wo rd' https://x", `curl -u admin:'${m}' https://x`],
    [`curl -u admin:"pa ss wo rd" https://x`, `curl -u admin:"${m}" https://x`],
    ["sshpass -p 'pa ss word 1234' ssh x", `sshpass -p '${m}' ssh x`],
    [`sshpass -p "pa ss word 1234" ssh x`, `sshpass -p "${m}" ssh x`],
    ["sshpass -p'pa ss word 1234' ssh x", `sshpass -p'${m}' ssh x`],
    ["docker login -u me -p 'pa ss word' ghcr.io", `docker login -u me -p '${m}' ghcr.io`],
    ["redis-cli -a 'pa ss word' ping", `redis-cli -a '${m}' ping`],
    ["mysql -h db -p'pa ss word' app", `mysql -h db -p'${m}' app`],
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
    `curl -ku "$API_USER:$API_PASS" http://127.0.0.1/`,
    `curl -u "admin:$API_PASS" http://127.0.0.1/`,
    `curl -u admin:"$API_PASS" http://127.0.0.1/`,
    `curl -u "admin:" http://127.0.0.1/`,
    `sshpass -p "$SSH_PASS" ssh x`,
    "sshpass -f secrets.txt ssh x",
    "curl -fsSL https://x",
    "curl -sS -o out.txt https://x",
    `curl -H "Accept: json" -X PUT https://x`,
    "curl -u admin: http://127.0.0.1/",
    "curl -u admin http://127.0.0.1/",
    "curl http://127.0.0.1/ && grep -p x",
    "tar -xf a.tar -C out -p",
    "redis-cli -h cache ping",
  ]) {
    assert.equal(redactOne(text), text);
  }
});

test("masks a credential in the shapes code and config files spell it in", () => {
  const m = marker("assignment");
  const value = "hG7xQ2pLm9Wz4Rt8";
  const cut: [string, string][] = [
    // A camelCase name with a quoted value is data, whatever stands between them.
    [`clientSecret: "${value}"`, `clientSecret: "${m}"`],
    [`authToken: "${value}",`, `authToken: "${m}",`],
    [`accessToken: '${value}',`, `accessToken: '${m}',`],
    [`const dbPass = "${value}";`, `const dbPass = "${m}";`],
    [`userPassword = "${value}"`, `userPassword = "${m}"`],
    [`accessToken="${value}"`, `accessToken="${m}"`],
    [`this.authToken = "${value}";`, `this.authToken = "${m}";`],
    // What is code as often as data, unless what follows is in quotes.
    [`'password' => '${value}'`, `'password' => '${m}'`],
    [`"password" => "${value}"`, `"password" => "${m}"`],
    [`:password => "${value}"`, `:password => "${m}"`],
    [`'dbPassword' => '${value}'`, `'dbPassword' => '${m}'`],
    [`password := "${value}"`, `password := "${m}"`],
    [`password:="${value}"`, `password:="${m}"`],
    [`password == "${value}"`, `password == "${m}"`],
    [`password === "${value}"`, `password === "${m}"`],
    [`password != "${value}"`, `password != "${m}"`],
    [`if (password !== '${value}') {`, `if (password !== '${m}') {`],
    [`os.environ["DB_PASSWORD"] = "${value}"`, `os.environ["DB_PASSWORD"] = "${m}"`],
    [`os.environ['API_KEY']='${value}'`, `os.environ['API_KEY']='${m}'`],
    [`ENV["STRIPE_KEY"] = "${value}"`, `ENV["STRIPE_KEY"] = "${m}"`],
    // SQL.
    [`CREATE USER a WITH PASSWORD '${value}'`, `CREATE USER a WITH PASSWORD '${m}'`],
    [`ALTER USER a PASSWORD '${value}';`, `ALTER USER a PASSWORD '${m}';`],
    [`create user a with password '${value}'`, `create user a with password '${m}'`],
    [`GRANT ALL ON *.* TO a IDENTIFIED BY '${value}'`, `GRANT ALL ON *.* TO a IDENTIFIED BY '${m}'`],
    [`identified by "${value}"`, `identified by "${m}"`],
    // XML.
    [`<password>${value}</password>`, `<password>${m}</password>`],
    [`<Password>${value}</Password>`, `<Password>${m}</Password>`],
    [`<apiKey>${value}</apiKey>`, `<apiKey>${m}</apiKey>`],
    [`<clientSecret>${value}</clientSecret>`, `<clientSecret>${m}</clientSecret>`],
    // `.netrc`, on a line or over three.
    [`machine h login a password ${value}`, `machine h login a password ${m}`],
    [`machine h\n  login a\n  password ${value}\n`, `machine h\n  login a\n  password ${m}\n`],
    // A connection string, which runs on past the `;`.
    [`AccountKey=${value};`, `AccountKey=${m}`],
    [`DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${value};EndpointSuffix=x`, `DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${m}`],
    [`Pwd=${value};`, `Pwd=${m}`],
    // A signed URL, which a request's other parameters do not sign.
    [`https://a.blob.core.windows.net/c/b?sv=2024&sig=${value}&se=2025`, `https://a.blob.core.windows.net/c/b?sv=2024&sig=${m}&se=2025`],
    [`?sig=${value}`, `?sig=${m}`],
    [`https://b.s3.amazonaws.com/k?X-Amz-Signature=${value}`, `https://b.s3.amazonaws.com/k?X-Amz-Signature=${m}`],
    [`https://x/y?a=1&x-goog-signature=${value}#top`, `https://x/y?a=1&x-goog-signature=${m}#top`],
    [`https://x/y?Signature=${value}&Expires=1`, `https://x/y?Signature=${m}&Expires=1`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }

  for (const text of [
    "password => password.trim()",
    "token => token.length",
    "const check = secret => secret.value;",
    `password := os.Getenv("DB_PASSWORD")`,
    "token := jwt.New()",
    "password == confirmPassword",
    "password === confirmPassword",
    "token != null",
    "auth === undefined",
    "adminPassword = someVariable",
    "dbPass: process.env.DB_PASS",
    "authToken: getToken()",
    "this.authToken = req.headers.token;",
    'clientSecret: "${process.env.CLIENT_SECRET}"',
    'clientSecret: "$CLIENT_SECRET"',
    'clientSecret: "<your secret>"',
    'authToken: "short"',
    "CREATE USER a WITH PASSWORD :pw",
    "ALTER USER a PASSWORD $1",
    "IDENTIFIED BY password",
    "identified by $1",
    "the password 'short'",
    "<password>${DB_PASSWORD}</password>",
    "<password>{{ password }}</password>",
    "<password>short</password>",
    "<password></password>",
    "<dbname>production_database</dbname>",
    "https://api.telegram.org/bot<token>/getUpdates",
    "machine h login a password $NETRC_PASSWORD",
    "machine learning models login with password",
    "Pwd=$DB_PASSWORD;",
    "PWD=/srv/someone/projects",
    "pwd=/srv/someone/projects",
    "AccountKey=$STORAGE_KEY;",
    "https://x/y?design=abcdefghijklm",
    "https://x/y?a=1&assign=abcdefghijklm",
    "https://x/y?sig=short",
    "https://x/y?sig=$SIGNATURE",
    "https://x/y?signature=",
    "grep password src/auth/login.ts",
  ]) {
    assert.equal(redactOne(text), text);
  }
});

test("masks a password where the common clients take one on their command line", () => {
  const m = marker("assignment");
  const value = "hG7xQ2pLm9Wz";
  const cut: [string, string][] = [
    [`mongosh -u root -p ${value} --authenticationDatabase admin`, `mongosh -u root -p ${m} --authenticationDatabase admin`],
    [`mongo -u root -p ${value} admin`, `mongo -u root -p ${m} admin`],
    [`mongodump -u root -p ${value} --db app`, `mongodump -u root -p ${m} --db app`],
    [`mongorestore -u root -p '${value}' dump/`, `mongorestore -u root -p '${m}' dump/`],
    [`cqlsh -u cassandra -p ${value} host`, `cqlsh -u cassandra -p ${m} host`],
    [`sqlcmd -S db -U sa -P ${value} -Q "select 1"`, `sqlcmd -S db -U sa -P ${m} -Q "select 1"`],
    [`sqlcmd -S db -U sa -P '${value}'`, `sqlcmd -S db -U sa -P '${m}'`],
    [`bcp t out f -S db -U sa -P ${value}`, `bcp t out f -S db -U sa -P ${m}`],
    [`sqlplus system/${value}@//db:1521/XE`, `sqlplus system/${m}`],
    [`sqlplus -S system/${value}@db`, `sqlplus -S system/${m}`],
    [`rabbitmqctl add_user app ${value}`, `rabbitmqctl add_user app ${m}`],
    [`rabbitmqctl change_password app ${value}`, `rabbitmqctl change_password app ${m}`],
    [`plink -pw ${value} root@host`, `plink -pw ${m} root@host`],
    [`pscp -pw ${value} a root@host:/`, `pscp -pw ${m} a root@host:/`],
    [`lftp -u user,${value} sftp://host`, `lftp -u user,${m} sftp://host`],
    [`smbclient //host/share -U user%${value}`, `smbclient //host/share -U user%${m}`],
    [`zip -P ${value} a.zip b`, `zip -P ${m} a.zip b`],
    [`unzip -P ${value} a.zip`, `unzip -P ${m} a.zip`],
    [`7z a -p${value} a.7z b`, `7z a -p${m} a.7z b`],
    [`ssh-keygen -t ed25519 -N '${value}' -f k`, `ssh-keygen -t ed25519 -N '${m}' -f k`],
    [`keytool -genkey -storepass ${value} -keypass ${value} -keystore k`, `keytool -genkey -storepass ${m} -keypass ${m} -keystore k`],
    [`jarsigner -storepass ${value} a.jar alias`, `jarsigner -storepass ${m} a.jar alias`],
    [`htpasswd -b .htpasswd admin ${value}`, `htpasswd -b .htpasswd admin ${m}`],
    [`htpasswd -bc .htpasswd admin ${value}`, `htpasswd -bc .htpasswd admin ${m}`],
    [`htpasswd -nb admin ${value}`, `htpasswd -nb admin ${m}`],
    [`curl -b "session=${value}" https://h`, `curl -b "${m}" https://h`],
    [`curl -s --cookie 'a=1; session=${value}' https://h`, `curl -s --cookie '${m}' https://h`],
    [`http -a admin:${value} https://h`, `http -a admin:${m} https://h`],
    [`xh -a admin:${value} https://h`, `xh -a admin:${m} https://h`],
    [`helm registry login ghcr.io -u a -p ${value}`, `helm registry login ghcr.io -u a -p ${m}`],
    [`az login -u a -p ${value}`, `az login -u a -p ${m}`],
    [`az login --service-principal -u id -p ${value} --tenant t`, `az login --service-principal -u id -p ${m} --tenant t`],
    [`twine upload -u a -p ${value} dist/x`, `twine upload -u a -p ${m} dist/x`],
    [`aws configure set aws_secret_access_key ${value}`, `aws configure set aws_secret_access_key ${m}`],
    [`npm config set //registry.npmjs.org/:_authToken ${value}`, `npm config set //registry.npmjs.org/:_authToken ${m}`],
    [`yarn config set npmAuthToken ${value}`, `yarn config set npmAuthToken ${m}`],
    [`setx API_KEY ${value}`, `setx API_KEY ${m}`],
    [`setenv API_KEY ${value}`, `setenv API_KEY ${m}`],
    [`set -x API_KEY ${value}`, `set -x API_KEY ${m}`],
    [`set -gx DB_PASSWORD ${value}`, `set -gx DB_PASSWORD ${m}`],
    [`vault login ${value}`, `vault login ${m}`],
    [`psql -c "ALTER USER a PASSWORD '${value}'"`, `psql -c "ALTER USER a PASSWORD '${m}'"`],
    [`mysql -e "CREATE USER a IDENTIFIED BY '${value}'"`, `mysql -e "CREATE USER a IDENTIFIED BY '${m}'"`],
    [`mysql -e "SET PASSWORD FOR 'a'@'%' = '${value}'"`, `mysql -e "SET PASSWORD FOR 'a'@'%' = '${m}'"`],
    // A script of the project's own says nothing by its flags, and what follows has to look generated.
    [`./run.sh -p ${value}`, `./run.sh -p ${m}`],
    [`./deploy --key ${value}`, `./deploy --key ${m}`],
    [`./deploy --pwd ${value}`, `./deploy --pwd ${m}`],
    [`bash ./scripts/deploy.sh --env prod -p "${value}"`, `bash ./scripts/deploy.sh --env prod -p "${m}"`],
    [`mongosh --username root -p ${value}`, `mongosh --username root -p ${m}`],
    [`lftp -u 'user,${value}' sftp://host`, `lftp -u 'user,${m}' sftp://host`],
    [`smbclient //host/share -U 'user%${value}'`, `smbclient //host/share -U 'user%${m}'`],
    [`smbclient //host/share ${value} -U user`, `smbclient //host/share ${m} -U user`],
    [`net use x: //host/share /user:admin ${value}`, `net use x: //host/share /user:admin ${m}`],
    [`http -a 'admin:${value}' https://h`, `http -a 'admin:${m}' https://h`],
    [`mysql -e "ALTER USER a IDENTIFIED WITH mysql_native_password BY '${value}'"`, `mysql -e "ALTER USER a IDENTIFIED WITH mysql_native_password BY '${m}'"`],
    [`ngrok config add-authtoken ${value}`, `ngrok config add-authtoken ${m}`],
    [`ngrok authtoken ${value}`, `ngrok authtoken ${m}`],
    [`gh secret set API_KEY --body ${value}`, `gh secret set API_KEY --body ${m}`],
    [`doctl auth init -t ${value}`, `doctl auth init -t ${m}`],
    [`wp config set DB_PASSWORD ${value}`, `wp config set DB_PASSWORD ${m}`],
    [`poetry config pypi-token.pypi ${value}`, `poetry config pypi-token.pypi ${m}`],
    [`poetry config http-basic.x user ${value}`, `poetry config http-basic.x user ${m}`],
    [`composer config http-basic.h user ${value}`, `composer config http-basic.h user ${m}`],
    [`security add-generic-password -a me -s svc -w ${value}`, `security add-generic-password -a me -s svc -w ${m}`],
    [`[Environment]::SetEnvironmentVariable("API_KEY", "${value}", "User")`, `[Environment]::SetEnvironmentVariable("API_KEY", "${m}", "User")`],
    [`sonar-scanner -Dsonar.login=${value}`, `sonar-scanner -Dsonar.login=${m}`],
    [`echo ${value} | docker login -u a --password-stdin`, `echo ${m} | docker login -u a --password-stdin`],
    [`echo "${value}" | gh auth login --with-token`, `echo "${m}" | gh auth login --with-token`],
    [`gh auth login --with-token <<< ${value}`, `gh auth login --with-token <<< ${m}`],
    [`wrangler secret put X <<< "${value}"`, `wrangler secret put X <<< "${m}"`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }

  for (const text of [
    "docker run -d --name mongo -p 27017:27017 mongo",
    "docker run --name cqlsh -p 9042:9042 cassandra",
    "mongosh -u root -p --authenticationDatabase admin",
    "mongosh --port 27017",
    "wget https://example.com/a.zip -P /tmp/downloads",
    "docker run -P nginx",
    "unzip -p a.zip file.txt",
    "gzip -P9 file",
    "7z x a.7z -o./out -y",
    "sqlcmd -S db -E",
    "sqlplus / as sysdba",
    "sqlplus -S /nolog",
    "sqlplus @scripts/run.sql",
    "ssh-keygen -t ed25519 -N '' -f k",
    `ssh-keygen -t ed25519 -N "" -f k`,
    `ssh-keygen -f k -N "$KEY_PASS"`,
    "htpasswd -c .htpasswd admin",
    "htpasswd -b .htpasswd admin $HTPASS",
    "keytool -list -storepass:env STORE_PASS -keystore k",
    "curl -b cookies.txt -c cookies.txt https://h",
    "http GET https://h -a",
    "wget http://h/a -a /var/log/wget.log",
    "helm registry login ghcr.io -u a --password-stdin",
    "az login",
    "az login --use-device-code",
    "aws configure set region eu-west-1",
    "npm config set registry https://registry.npmjs.org/",
    "setx PATH /usr/local/bin",
    "set -x",
    "set -x; echo token",
    "vault login",
    "vault login -method=github",
    "vault login $VAULT_TOKEN",
    "the vault login failed",
    "rabbitmqctl list_users",
    "./run.sh -p 8080",
    "./run.sh -p /tmp/out",
    "./deploy --key id_ed25519",
    "./deploy --key ~/.ssh/id_rsa",
    "./deploy --pwd /srv/app",
    "./gradlew build -p subprojects",
    "git log -p 3f49db0abc12",
    "mkdir -p a1b2c3d4e5f6",
    "./run.sh -p build/abc123def456/out",
    "docker run --name mongo -u 1000 -p 27017:27017 mongo",
    "htpasswd -n admin > users",
    "the keypass database",
    "the vault login succeeded",
    "cp a.7z -p dir",
    "echo $TOKEN | docker login -u a --password-stdin",
    `echo "$TOKEN" | gh auth login --with-token`,
    "cat key.txt | docker login --password-stdin",
    "echo hello | wc -c",
    "gh secret set API_KEY < key.txt",
    `gh pr create --body "fixes login"`,
    "smbclient -L host -U user",
    "net use",
    "ngrok http 8080",
    `grep foo <<< "$TEXT"`,
    "wc -c <<< hello",
    "security find-generic-password -a me -w",
    "doctl auth init",
    "poetry config virtualenvs.in-project true",
    "composer config minimum-stability dev",
    "wp config set WP_DEBUG true",
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
    // With no space after the `=`, and in quotes, what is inside is the value.
    ["PASSWORD=Xy7{aB!9]kL2<pQ", `PASSWORD=${m}`],
    ["PASSWORD=abc{def}ghi12345", `PASSWORD=${m}`],
    ["PASSWORD=abc[def]ghi12345", `PASSWORD=${m}`],
    ["PASSWORD=abc<def>ghi12345", `PASSWORD=${m}`],
    ["API_KEY=ab]cdefghijklmnop", `API_KEY=${m}`],
    ["accessToken=abc{def}ghi12345", `accessToken=${m}`],
    ["PASSWORD='abc{def}ghi12345'", `PASSWORD='${m}'`],
    [`PASSWORD="abc{def}ghi12345"`, `PASSWORD="${m}"`],
    [`password = "abc[def]ghi12345"`, `password = "${m}"`],
    ["export DB_PASSWORD='p@ss[w0rd]{123}'", `export DB_PASSWORD='${m}'`],
    [`PASSWORD="it's-a-secret-1234"`, `PASSWORD="${m}"`],
    [`PASSWORD='say-"hi"-secret-1234'`, `PASSWORD='${m}'`],
    [`{"accessToken":"abc{def}ghi12345"}`, `{"accessToken":"${m}"}`],
    [`app --password "abc{def}ghi12345"`, `app --password "${m}"`],
    // A `$` a shell would not expand: a hash in JSON, a password that opens with one.
    [`"password": "$2b$10$abcdefghijklmnopqrstuv"`, `"password": "${m}"`],
    [`SECRET="$tr0ngPassw0rd99"`, `SECRET="${m}"`],
    [`SECRET="$Tr0ngPassw0rd99"`, `SECRET="${m}"`],
    // What closes around the assignment stays out of it.
    ["{PASSWORD=abcdefgh12345}", `{PASSWORD=${m}}`],
    ["[token=abcdefgh12345] done", `[token=${m}] done`],
    ["<input password=abcdefgh12345>", `<input password=${m}>`],
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
    `SECRET="$DB_PASS_2"`,
    `SECRET="\${DB_PASS}"`,
    `SECRET="$(cat f1)"`,
    `SECRET="$HOME/s3cret/x1"`,
    `SECRET="$secret"`,
    "PASSWORD=$tr0ngPassw0rd99",
    "token = tokens[index]",
    "token: tokens[index],",
    "password = values<string>",
    "if (token==tokens[index]) {}",
    "PASSWORD=<your-password>",
    "PASSWORD={{ password }}",
    "PASSWORD=[hidden]",
    `"password": "<your-password>"`,
    `"token": "{{ token }}"`,
    `"token": "{token}"`,
    `"password": "[hidden]"`,
  ]) {
    assert.equal(redactOne(text), text);
  }
  // A call's long name goes, and what it is called with stays.
  assert.equal(redactOne("token: getToken()"), `token: ${m}()`);
});

test("reads a chain of calls as one call, and a bracket with a letter after it as a password", () => {
  const m = marker("assignment");
  for (const text of [
    "password = hash(input).digest('hex')",
    "password = hash(input).digest();",
    "password=hash(input).digest()",
    "secret: foo.bar(baz).qux()",
    "secret = foo.bar(baz).qux(),",
    "password = input().strip()",
    "password = String(input).trim()",
    "password = foo().bar",
    "password = foo().bar.baz()",
    "token = foo(bar(baz))",
    "token = foo(bar(baz)),",
    "wrap(password = hash(input))",
    "wrap(password = hash(input));",
    "token = foo(x)!",
    "token = foo(x)?.bar",
    "token = foo(x)[0]",
    "token = foo(x)+1",
  ]) {
    assert.equal(redactOne(text), text);
  }
  // A call's long name goes, and what it is called with stays.
  const cut: [string, string][] = [
    ["token = getToken().trim()", `token = ${m}().trim()`],
    ["token=getToken().trim()", `token=${m}().trim()`],
    ["token: getToken().trim(),", `token: ${m}().trim(),`],
    ["const token = jwt.sign(payload).toString();", `const token = ${m}(payload).toString();`],
    ["const token = jwt.sign(payload,key).toString();", `const token = ${m}(payload,key).toString();`],
    ["token: this.auth.getToken().pipe(take(1)),", `token: ${m}().pipe(take(1)),`],
    ["password = generate(16).toString(36).slice(2)", `password = ${m}(16).toString(36).slice(2)`],
    [`secret = Buffer.from(x).toString("hex")`, `secret = ${m}(x).toString("hex")`],
    ["token: useToken().value", `token: ${m}().value`],
    ["PASSWORD=abc(def)ghi12345", `PASSWORD=${m}`],
    ["password = abc(def)ghi12345", `password = ${m}`],
    ["PASSWORD=abc(def)ghi(j)k", `PASSWORD=${m}`],
    [`password = "hash(input).digest"`, `password = "${m}"`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
    assert.equal(redactOne(expected), expected, "a second pass changes nothing");
  }
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
    ["db-pwd=Zq8vR2mK9xLp", `db-pwd=${m}`],
    ["jdbc.pwd=Zq8vR2mK9xLp", `jdbc.pwd=${m}`],
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
    "--pwd /srv/app/current",
    "./pwd=/srv/app/current",
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

test("one of these words alone, spaced from a plain word, names nothing: test output, prose and code stay", () => {
  for (const text of [
    "--- PASS: TestParserKeepsHeredocs (0.01s)",
    "    --- PASS: TestV2Parser/heredoc_case (0.00s)",
    "PASS: src/foo/bar.test.ts",
    "PASS: test-suite-12345678",
    "First pass: everything compiles",
    "tests pass: everything green",
    "pass: undefined,",
    "pass = compute_something(x)",
    "pass: process.env.SMTP_PASS",
    "auth: requireAuthentication,",
    "const auth = getAuthentication();",
    "export const auth = betterAuth({",
    "Auth: Required",
    "auth:\n  required_everywhere",
    "credential = getCredential()",
    "credentials: path/to/file.json",
    "cookie: SerializedCookie | undefined,",
    "const cookie = parseCookie(req);",
    "cookie = req.headers.cookie;",
    "const cookie = req.headers.cookie ?? '';",
    "if (cookie == null) return next();",
    "if (cookie === undefined) return next();",
    "Cookie: required for the session flow",
  ]) {
    assert.equal(redactOne(text), text);
  }

  const m = marker("assignment");
  const cut: [string, string][] = [
    ["pass: hunter2000", `pass: ${m}`],
    [`pass: "sunshine"`, `pass: "${m}"`],
    ["pass: 'sunshine'", `pass: '${m}'`],
    ["pass=sunshine", `pass=${m}`],
    ["PASS=sunshine", `PASS=${m}`],
    ["smtp_pass: sunshine", `smtp_pass: ${m}`],
    ["auth: dXNlcjpwYXNz1", `auth: ${m}`],
    [`"auth": "dXNlcjpwYXNz"`, `"auth": "${m}"`],
    ["AUTH=dXNlcjpwYXNz", `AUTH=${m}`],
    [`credentials: "dXNlcjpwYXNz"`, `credentials: "${m}"`],
    ["cookie: abcdefgh1", `cookie: ${m}`],
    [`"cookie": "abcdefgh"`, `"cookie": "${m}"`],
  ];
  for (const [text, expected] of cut) {
    assert.equal(redactOne(text), expected);
  }
});

test("a NAME_KEY goes when what it holds looks generated, and stays when it holds a name", () => {
  const m = marker("assignment");
  const value = "hG7xQ2pLm9Wz4Rt8";
  for (const name of ["STRIPE_KEY", "APP_KEY", "ENCRYPTION_KEY", "SIGNING_KEY", "MASTER_KEY", "OPENAI_KEY", "ANTHROPIC_KEY", "SENDGRID_KEY", "HMAC_KEY", "SUPABASE_SERVICE_ROLE_KEY", "KEY"]) {
    const cut: [string, string][] = [
      [`${name}=${value}`, `${name}=${m}`],
      [`export ${name}=${value}`, `export ${name}=${m}`],
      [`${name}: ${value}`, `${name}: ${m}`],
      [`"${name}": "${value}"`, `"${name}": "${m}"`],
      [`kubectl create secret generic s --from-literal=${name}=${value}`, `kubectl create secret generic s --from-literal=${name}=${m}`],
      [`process.env.${name} = "${value}"`, `process.env.${name} = "${m}"`],
    ];
    for (const [text, expected] of cut) {
      assert.equal(redactOne(text), expected);
      assert.equal(redactOne(expected), expected, "a second pass changes nothing");
    }
  }
  assert.equal(redactOne("APP_KEY=base64:Zq8vR2mK9xLpWq7="), `APP_KEY=${m}`);

  for (const text of [
    "SORT_KEY=name",
    "SORT_KEY=created_at",
    "PRIMARY_KEY=customer_identifier",
    "CACHE_KEY=organizationSettings",
    "SSH_KEY=~/.ssh/id_ed25519",
    "PARTITION_KEY: $TENANT_ID",
    "APP_KEY=${APP_KEY}",
    `FOREIGN_KEY = "organization_identifier"`,
    "MONKEY=hG7xQ2pLm9Wz4Rt8",
    "sort_key=hG7xQ2pLm9Wz4Rt8",
  ]) {
    assert.equal(redactOne(text), text);
  }

  // A field holds it the same as a line of text does.
  const { input } = throughCall("mcp__x__deploy", { env: { STRIPE_KEY: value, SORT_KEY: "created_at_desc" } }, "ok");
  assert.deepEqual(input.env, { STRIPE_KEY: m, SORT_KEY: "created_at_desc" });
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

test("a secret's name stays one through its value, its environment and its version", () => {
  const masked = marker("assignment");
  const value = "aB3dE6gH9jK2mN5p";
  for (const name of [
    "DB_PASSWORD_PROD",
    "DB_PASSWORD_PRODUCTION",
    "API_KEY_PROD",
    "AUTH_TOKEN_DEV",
    "SESSION_SECRET_OLD",
    "JWT_SECRET_NEW",
    "stripe_secret_key_live",
    "STRIPE_SECRET_KEY_TEST",
    "SMTP_PASSWORD_STAGING",
    "SMTP_PASSWORD_STAGE",
    "ADMIN_TOKEN_LOCAL",
    "SECRET_KEY_BASE_OLD",
    "GITHUB_TOKEN_2",
    "API_KEY_PROD_2",
    "SECRET_VALUE",
    "token_value",
    "api_key_value",
    "secret-old",
    "DB_PWD_PROD",
    "accessTokenProd",
    "apiKeyProd",
    "dbPasswordOld",
    "secretOld",
    "tokenValue",
    "accessToken2",
  ]) {
    assert.equal(redactOne(`${name}=${value}`), `${name}=${masked}`, name);
    assert.equal(redactOne(`${name}: "${value}"`), `${name}: "${masked}"`, name);
    const record = redactOne(JSON.stringify({ [name]: value }));
    assert.equal(record, JSON.stringify({ [name]: masked }), name);
  }

  assert.deepEqual(throughCall("mcp__vault__put", { DB_PASSWORD_PROD: value, accessToken2: value, tokenValue: value }, "plain output").input, {
    DB_PASSWORD_PROD: masked,
    accessToken2: masked,
    tokenValue: masked,
  });

  // A plain name takes a space and no quote, and a hump is as often code.
  assert.equal(redactOne(`DB_PASSWORD_PROD = ${value}`), `DB_PASSWORD_PROD = ${masked}`);
  assert.equal(redactOne(`export API_KEY_PROD=${value} && psql`), `export API_KEY_PROD=${masked} && psql`);
  assert.equal(redactOne(`--token-prod ${value}`), `--token-prod ${masked}`);
  for (const text of [
    "const tokenValue = someLongVariableName",
    "secretValue: someLongVariableName",
    `tokenValue = ${value}`,
    `accessTokenProd: ${value}`,
  ]) {
    assert.equal(redactOne(text), text);
  }
});

test("what is said about a secret still ends in a word of its own", () => {
  for (const name of [
    "PASSWORD_HASH",
    "passwordHash",
    "TOKEN_COUNT",
    "token_program",
    "destination_token_program",
    "owner_token_x",
    "tokens_old",
    "token_prodigy",
    "secret_newsletter",
    "token_2022",
    "klend-repay-token2022",
    "token0",
    "token1",
    "oauth2",
    "password2",
  ]) {
    const text = `${name}=aB3dE6gH9jK2mN5p`;
    assert.equal(redactOne(text), text);
  }
});

test("a camelCase name ending in a secret's word, spaced from a bare value, counts when the value looks generated", () => {
  const masked = marker("assignment");
  for (const name of ["accessToken", "refreshToken", "clientSecret", "dbPassword", "_authToken"]) {
    assert.equal(redactOne(`${name}: aB3dE6gH9jK2mN5p`), `${name}: ${masked}`, name);
    assert.equal(redactOne(`  ${name}:  aB3dE6gH9jK2mN5p,`), `  ${name}:  ${masked}`, name);
  }
  for (const text of [
    "accessToken: string",
    "accessToken: request.headers.authorization",
    "clientSecret: process.env.CLIENT_SECRET",
    "dbPassword: documentation",
    "accessToken: 202410201230",
    "accessToken = aB3dE6gH9jK2mN5p",
    "accessToken:aB3dE6gH9jK2mN5p",
    "accessTokenUrl: aB3dE6gH9jK2mN5p",
    "myApiKey: aB3dE6gH9jK2mN5p",
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
    "cat $(ls .env*)",
    "ls .env* | xargs cat",
    "echo .env | xargs -n1 cut -d= -f2",
    "echo \"$(<.env)\"",
    "echo \"$(grep X \"$(dirname $0)/.env\")\"",
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
    "git add .env.example && git commit -m \"$(date)\"",
    "test -f .env && echo \"$(date)\"",
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
    `START_CMD="npm run build"`,
    "TEST_COMMAND='npm run test -- --ci'",
    `APP_NAME="My Cool Application"`,
    "PIN_CODE=1234567890123",
    "CLIENT_REGION=eu-central-1",
    `const MARKER = "<!-- isy:comment:v1 -->";`,
  ].join("\n");
  const text = "Run npm run build, then npm run test -- --ci for My Cool Application. In production the password is read at http://localhost:3000 and https://api.example.com/v1 for /srv/app/current/release/public, unless true: changeme, Transcript, Zq8vR2m, 3000, 1234567890123, claude-opus-5-5 in eu-central-1 under <!-- isy:comment:v1 -->.";
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

test("a long ordinary value under a name nothing knows stays, and a generated one goes", () => {
  const m = marker("dotenv");
  const quoted = (line: string): string => {
    const { lines } = summaryFor([...callAndResult("Read", { file_path: "/repo/.env" }, line), { type: "user", uuid: "u", message: { role: "user", content: `the value ${line.slice(line.indexOf("=") + 1)} here` } }]);
    return (JSON.parse(lines.at(-1)!) as { message: { content: string } }).message.content;
  };
  for (const line of [
    "DOCS_URL=https://documentation.example.com",
    "ORIGIN=https://www.transportation.example.org",
    "BUCKET=s3://organisation-production-backups",
    "APP_NAME=MyCoolApplication",
    "DB_NAME=PRODUCTION_DATABASE",
    "ALLOWED_METHODS=GET,POST,PUT,DELETE",
    "FONT_STACK=Helvetica,Arial,sans-serif",
    "CLOUD_REGION=northamerica-northeast1",
    "SERVICE=transcription-service",
    "IMAGE=registry.example.com/backend:202410201230",
    "NODE_OPTIONS=--max-old-space-size=4096",
    "CACHE_CONTROL=public,max-age=31536000",
    "CIPHER=TLS_AES_256_GCM_SHA384",
  ]) {
    const value = line.slice(line.indexOf("=") + 1);
    assert.equal(quoted(line), `the value ${value} here`);
  }
  for (const line of [
    "MAILER_PHRASE=Zq8vR2mK9xLp",
    "UPSTREAM=abcd1234efgh5678",
    "SESSION_ID=550e8400-e29b-41d4-a716-446655440abc",
    "HOOK=https://hooks.example.com/services/T0000/B0000/XXXXabcd1234",
    "WEIRD=p@ss-w0rd!x#9zz",
    "BLOB=dGVzdGluZ3Rlc3Rpbmc=",
  ]) {
    assert.equal(quoted(line), `the value ${m} here`);
  }
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
    ["export VALUE=Zq8vR2mK9xLp\ncat > .env <<EOF\nK=$VALUE\nEOF", `${m} > .env`],
    // A redirect that overrides `noclobber`.
    ["echo DB_PASS=Zq8vR2mK9xLp >| .env", `${m} > .env`],
    // The file in a variable, or a loop's.
    ["F=.env; echo K=Zq8vR2mK9xLp > $F", `${m} > .env`],
    ['F=.env; echo K=Zq8vR2mK9xLp > "$F"', `${m} > .env`],
    ['F=".env.local"; echo K=Zq8vR2mK9xLp > ${F}', `${m} > .env.local`],
    ["F=.env; cat > $F <<EOF\nK=Zq8vR2mK9xLp\nEOF", `${m} > .env`],
    ["for f in .env .env.local; do echo K=Zq8vR2mK9xLp >> $f; done", `${m} > .env`],
    ['for v in Zq8vR2mK9xLp; do echo "K=$v" > .env; done', `${m} > .env`],
    // The values where the write does not name them.
    ["exec 3>.env; echo K=Zq8vR2mK9xLp >&3", `${m} > .env`],
    ["export X=Zq8vR2mK9xLp; envsubst < tpl > .env", `${m} > .env`],
    // A heredoc's delimiter quoted the other way.
    ["cat > .env <<\\EOF\nK=Zq8vR2mK9xLp\nEOF", `${m} > .env`],
    // A script fed to a shell, the value set outside it.
    ['X=Zq8vR2mK9xLp; ssh host <<EOF\necho "K=$X" >> /app/.env\nEOF', `${m} > /app/.env`],
    // A write in a quoted remote command.
    ["ssh host 'tee /app/.env' <<EOF\nK=Zq8vR2mK9xLp\nEOF", `${m} > /app/.env`],
    ['echo K=Zq8vR2mK9xLp | ssh host "tee -a /app/.env"', `${m} > /app/.env`],
    // An interpreter's one-liner, which opens the file to write it.
    [`python3 -c "open('.env','w').write('K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    [`python3 -c "with open('.env', mode='a') as f: f.write('K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    [`python3 -c "open(\\".env\\", \\"w\\").write(\\"K=Zq8vR2mK9xLp\\")"`, `${m} > .env`],
    [`python3 -c "from pathlib import Path; Path('.env').write_text('K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    [`node -e "fs.writeFileSync('.env','K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    [`node -e "require('fs').appendFileSync('.env','K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    [`ruby -e "File.write('.env','K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    [`php -r "file_put_contents('.env','K=Zq8vR2mK9xLp');"`, `${m} > .env`],
    [`F=.env; node -e "fs.writeFileSync('$F','K=Zq8vR2mK9xLp')"`, `${m} > .env`],
    // What comes on stdin, copied there.
    ["dd of=.env <<< K=Zq8vR2mK9xLp", `${m} > .env`],
    ["cp /dev/stdin .env <<< K=Zq8vR2mK9xLp", `${m} > .env`],
    ["install /dev/stdin .env <<< K=Zq8vR2mK9xLp", `${m} > .env`],
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

test("a value written into a dotenv file is learned without the shell operator behind it", () => {
  const value = "Zq8vR2mK9xLp";
  for (const command of [
    `echo K=${value}>.env`,
    `echo K=${value}>>.env`,
    `echo K=${value}|tee .env`,
    `(echo K=${value})>.env`,
    `(echo K=${value}) > .env`,
    `$(echo K=${value}) > .env`,
    `cat .env; echo K=${value}>>.env`,
  ]) {
    const { lines } = summaryFor([
      ...callAndResult("Bash", { command }, "done"),
      { type: "user", message: { role: "user", content: `the key is ${value}` } },
    ]);
    assert.ok(!lines.join("\n").includes(value), command);
  }
  // A dotenv file may hold them, and the value goes whole as well.
  const whole = "aZ9bY8cX7&dW6eV5;fU4";
  const { lines } = summaryFor([
    ...callAndResult("Read", { file_path: ".env" }, `API_KEY=${whole}`),
    { type: "user", message: { role: "user", content: `the key is ${whole}, then aZ9bY8cX7` } },
  ]);
  assert.ok(!lines.join("\n").includes("aZ9bY8cX7"));
  assert.ok(!lines.join("\n").includes("fU4"));
});

test("what a command wrote into a dotenv file goes from the rest of the session, however it was written", () => {
  const value = "Zq8vR2mK9xLp";
  for (const command of [
    `F=.env; echo K=${value} > $F`,
    `F=.env; sed -i 's/a/${value}/' $F`,
    `for f in .env .env.local; do echo K=${value} >> $f; done`,
    `exec 3>.env; echo K=${value} >&3`,
    `export X=${value}; envsubst < tpl > .env`,
    `cat > .env <<\\EOF\nK=${value}\nEOF`,
    `ssh host 'tee /app/.env' <<EOF\nK=${value}\nEOF`,
    `echo K=${value} | ssh host "tee -a /app/.env"`,
    `python3 -c "open('.env','w').write('K=${value}')"`,
    `node -e "fs.writeFileSync('.env','K=${value}')"`,
    `dd of=.env <<< K=${value}`,
    `cp /dev/stdin .env <<< K=${value}`,
    // A shell or an interpreter fed a script that writes the file.
    `ssh host <<'REMOTE'\ncat > /app/.env <<'EOF'\nK=${value}\nEOF\nREMOTE`,
    `ssh host bash <<'REMOTE'\necho K=${value} >> /app/.env\nREMOTE`,
    `bash <<'SH'\necho K=${value} > .env\nSH`,
    `bash <<'SH'\necho K=${value} > prod.env\nSH`,
    `bash <<'SH'\nF=.env; echo K=${value} > $F\nSH`,
    `python3 - <<'PY'\nopen('.env','w').write('K=${value}')\nPY`,
    // In-place editors other than sed.
    `ruby -pi -e 'sub("a","${value}")' .env`,
    `ruby -i.bak -pe 'sub("a","${value}")' .env`,
    `awk -i inplace '{print "K=${value}"}' .env`,
    `gawk --include=inplace '{print "K=${value}"}' .env`,
    `perl -p -i -e 's/a/${value}/' .env`,
    `perl -0pi -e 's/a/${value}/' .env`,
  ]) {
    const { lines } = summaryFor([
      ...callAndResult("Bash", { command }, "done"),
      { type: "user", message: { role: "user", content: `the key is ${value}` } },
    ]);
    assert.ok(!lines.join("\n").includes(value), command);
  }

  // Reading it, in the same forms, or writing something else, leaves the command as it was.
  for (const command of [
    `python3 -c "print(open('.env').read())"`,
    `python3 -c "print(open('.env','r').read())"`,
    `python3 -c "print(open('.env', encoding='ascii').read())"`,
    `python3 -c "open('a.txt','w').write('.env')"`,
    `node -e "console.log(fs.readFileSync('.env','utf8'))"`,
    `ruby -e "puts File.read('.env')"`,
    "ruby -ne 'puts $_' .env",
    "awk '{print}' .env",
    "awk -i lib.awk '{print}' .env",
    "dd if=.env of=copy.txt",
    "install -m 600 a.txt .env",
    "F=a.txt; echo K=Zq8vR2mK9xLp > $F; cat .env",
    "for f in a.txt b.txt; do echo K=Zq8vR2mK9xLp > $f; done; cat .env",
  ]) {
    assert.equal(throughCall("Bash", { command }, "plain output").input.command, command);
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

test("a commit or pull request's message in a heredoc only says the word, and a script in one still reads the file", () => {
  for (const command of [
    `git commit -m "$(cat <<'EOF'\nStop tracking .env\nEOF\n)"`,
    `git add a && git commit -m "$(cat <<'EOF'\nStop tracking .env\nEOF\n)"`,
    `gh pr create --title x --body "$(cat <<'EOF'\nStop tracking .env\nEOF\n)"`,
    "git commit -F - <<EOF\nStop tracking .env\nEOF",
  ]) {
    const out = throughCall("Bash", { command }, "plain output");
    assert.equal(out.input.command, command);
    assert.equal(out.content, "plain output");
  }
  const m = marker("dotenv");
  for (const [command, expected] of [
    ["python3 - <<'PY'\nprint(open('.env').read())\nPY", `python3 - <<'PY'\n${m}\nPY`],
    ["gh api /x | python3 - <<'PY'\nprint(open('.env').read())\nPY", `gh api /x | python3 - <<'PY'\n${m}\nPY`],
    ["git log | sh <<'EOF'\ncat .env\nEOF", `git log | sh <<'EOF'\n${m}\nEOF`],
    [`git commit -m x; sh <<'EOF'\ncat .env\nEOF`, `git commit -m x; sh <<'EOF'\n${m}\nEOF`],
  ] as const) {
    const out = throughCall("Bash", { command }, "MAILER_PHRASE=Zq8vR2mK9xLp");
    assert.equal(out.input.command, expected);
    assert.equal(out.content, m, command);
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
    // The file its output lands in is read back as often as the task is asked.
    ...followed("t8", "Bash", { command: "tail -5 /tmp/tasks/bg1.output" }, command),
    ...followed("t9", "Read", { file_path: "/tmp/tasks/bg1.output" }, command),
    ...followed("t10", "Bash", { command: "tail -5 /tmp/tasks/bg2.output" }, "npm run dev"),
    ...followed("t11", "Read", { file_path: "/tmp/tasks/bg2.output" }, "npm run dev"),
  ]);
  const out = lines.map((line) => JSON.parse(line) as { message: { content: { content: string }[] }; toolUseResult: unknown });
  for (const i of [3, 5, 7, 9, 15, 17]) {
    assert.equal(out[i]!.message.content[0]!.content, marker("dotenv"));
    assert.equal(out[i]!.toolUseResult, marker("dotenv"));
  }
  for (const i of [13, 19, 21]) assert.equal(out[i]!.message.content[0]!.content, "stopped npm run dev");
  assert.ok(!lines.join("\n").includes(value));
});

test("a file named the other way round is a dotenv file too, and code reading the environment is not", () => {
  const m = marker("dotenv");
  for (const file_path of ["prod.env", "/repo/config/prod.env", "/repo/.x.env", "config/app.env"]) {
    const out = throughCall("Read", { file_path });
    assert.equal(out.content, m, file_path);
  }
  for (const command of ["cat prod.env", "cat config/*.env", "cut -d= -f2 config/app.env", "docker compose --env-file prod.env config", "git show HEAD:.x.env"]) {
    assert.equal(throughCall("Bash", { command }).content, m, command);
  }
  assert.equal(throughCall("Bash", { command: "echo K=Zq8vR2mK9xLp > prod.env" }).input.command, `${m} > prod.env`);
  assert.equal(throughCall("Write", { file_path: "prod.env", content: "K=Zq8vR2mK9xLp" }).input.content, m);

  for (const command of [
    "node -p process.env",
    `node -e "console.log(process.env)"`,
    `node -e "console.log(import.meta.env)"`,
    `node -e "console.log(Object.keys(globalThis.process.env))"`,
    "deno eval 'console.log(Deno.env)'",
    "cat src/foo.env.ts",
    "ls prod.env",
    "rg '.*\\.env' src",
    "python3 - <<'PY'\nprint(cfg.env)\nPY",
    "cat > src/a.ts <<'EOF'\nconst value = cfg.env;\nEOF",
  ]) {
    const out = throughCall("Bash", { command }, "plain output");
    assert.equal(out.input.command, command);
    assert.equal(out.content, "plain output", command);
  }
});

test("an in-place edit of a dotenv file loses its script, and stays an edit", () => {
  const m = marker("dotenv");
  const cases: [string, string, string][] = [
    ["sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i.bak 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' config/.env.local", `sed -i ${m} config/.env.local`, "config/.env.local"],
    ["sed -i -e 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    ["perl -pi -e 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    ["cd app && sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env && npm test", `cd app && sed -i ${m} .env && npm test`, "app/.env"],
    // The value sits where the script only names it.
    ['VALUE=Zq8vR2mK9xLp\nsed -i "s/^KEY=.*/KEY=$VALUE/" .env', `sed -i ${m} .env`, ".env"],
    ['VALUE=Zq8vR2mK9xLp; sed -i "s/^KEY=.*/KEY=${VALUE}/" .env', `sed -i ${m} .env`, ".env"],
    // In single quotes `$` is sed's own, the last line.
    ["sed -i '$a KEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i '$ a KEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i '$aKEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i '$iKEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i '$cKEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ['sed -i "\\$a KEY=Zq8vR2mK9xLp" .env', `sed -i ${m} .env`, ".env"],
    ["sed -i -e '$a KEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i '1iKEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    ["sed -i '/^KEY=/cKEY=Zq8vR2mK9xLp' .env", `sed -i ${m} .env`, ".env"],
    // Named by a variable, or from one.
    ["F=.env; sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' $F", `sed -i ${m} .env`, ".env"],
    [`F=.env; sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' "$F"`, `sed -i ${m} .env`, ".env"],
    [`sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' "$HOME/.env"`, `sed -i ${m} .env`, ".env"],
    [`for f in .env*; do sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' "$f"; done`, `sed -i ${m} .env`, ".env"],
    ["for f in a b; do sed -i 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env; done", `for f in a b; sed -i ${m} .env; done`, ".env"],
    // Its script in a heredoc.
    ["sed -i -f - .env <<EOF\ns/^KEY=.*/KEY=Zq8vR2mK9xLp/\nEOF", `sed -i ${m} .env`, ".env"],
    // The other in-place editors.
    ["perl -p -i -e 's/^KEY=.*/KEY=Zq8vR2mK9xLp/' .env", `sed -i ${m} .env`, ".env"],
    [`ruby -pi -e 'sub("a","Zq8vR2mK9xLp")' .env`, `sed -i ${m} .env`, ".env"],
    [`awk -i inplace '{print "KEY=Zq8vR2mK9xLp"}' .env`, `sed -i ${m} .env`, ".env"],
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

  for (const [command, value] of [
    ["sed -i 's|^KEY=.*|KEY=Zq8vR2mK9xLp|' .env", "Zq8vR2mK9xLp"],
    ['sed -i "s#^KEY=.*#KEY=Zq8vR2mK9xLp#" .env', "Zq8vR2mK9xLp"],
    ["sed -i 's,^KEY=.*,KEY=Zq8vR2mK9xLp,' .env", "Zq8vR2mK9xLp"],
    ["sed -i 's/^KEY=.*/KEY=Zq8v#R2m|K9xLp/' .env", "Zq8v#R2m|K9xLp"],
    ['VALUE=Zq8vR2mK9xLp; sed -i "s/^KEY=.*/KEY=$VALUE/" .env', "Zq8vR2mK9xLp"],
    ['VALUE=Zq8vR2mK9xLp; echo "KEY=$VALUE" > .env', "Zq8vR2mK9xLp"],
    ["sed -i '$a KEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
    ["sed -i '$ a KEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
    ["sed -i '$aKEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
    ["sed -i '$iKEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
    ["sed -i '$cKEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
    ["sed -i '1iKEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
    ["sed -i '/^KEY=/cKEY=Zq8vR2mK9xLp' .env", "Zq8vR2mK9xLp"],
  ] as const) {
    const session = summaryFor([
      ...callAndResult("Bash", { command }, ""),
      { type: "user", message: { role: "user", content: `the key is ${value}` } },
    ]);
    assert.ok(!session.lines.join("\n").includes(value), command);
  }

  const kept = "sed -i 's/a/b/' src/env.ts";
  assert.equal(throughCall("Bash", { command: kept }, "plain output").input.command, kept);
});

test("an in-place edit of a dotenv file loses its script behind whatever runs it, over any lines, and through a glob", () => {
  const m = marker("dotenv");
  const value = "Hy4tN7wB2cQs";
  const script = `'s/^K=.*/K=${value}/'`;
  const cases: [string, string][] = [
    [`sudo -u app sed -i ${script} .env`, `sed -i ${m} .env`],
    [`LC_ALL=C sed -i ${script} .env`, `sed -i ${m} .env`],
    [`time sed -i ${script} .env`, `sed -i ${m} .env`],
    [`/usr/bin/sed -i ${script} .env`, `sed -i ${m} .env`],
    [`env LC_ALL=C timeout 5 sed -i ${script} .env`, `sed -i ${m} .env`],
    [`(sed -i ${script} .env)`, `sed -i ${m} .env)`],
    [`time perl -pi -e ${script} .env`, `sed -i ${m} .env`],
    [`docker exec app sed -i ${script} /app/.env`, `sed -i ${m} /app/.env`],
    [`kubectl exec pod -- sed -i ${script} /app/.env`, `sed -i ${m} /app/.env`],
    // In the quotes of what runs it, among whatever else they hold.
    [`ssh host "sed -i ${script} /srv/.env"`, `sed -i ${m} /srv/.env`],
    [`bash -c "sed -i ${script} .env"`, `sed -i ${m} .env`],
    [`sh -c 'sed -i "s/^K=.*/K=${value}/" .env'`, `sed -i ${m} .env`],
    [`ssh host "cd /srv && sed -i ${script} .env && systemctl restart app"`, `sed -i ${m} .env`],
    // The files come from in front of it.
    [`find . -name .env -exec sed -i ${script} {} +`, `sed -i ${m} .env`],
    [`find . -name '.env*' -exec sed -i ${script} {} \\;`, `sed -i ${m} .env*`],
    [`find . -name '.env*' | xargs sed -i ${script}`, `sed -i ${m} .env*`],
    [`ls .env* | xargs -n1 sed -i ${script}`, `sed -i ${m} .env*`],
    [`grep -rl old --include='*.env' . | xargs sed -i 's/old/${value}/'`, `sed -i ${m} *.env`],
    // Files a glob stands for.
    [`sed -i ${script} .env*`, `sed -i ${m} .env*`],
    [`sed -i ${script} apps/*/.env`, `sed -i ${m} apps/*/.env`],
    // A line the shell joins to the next, and a quoted script over several.
    [`sed -i ${script} \\\n  .env`, `sed -i ${m} .env`],
    [`sed -i \\\n  ${script} \\\n  .env`, `sed -i ${m} .env`],
    [`sed -i \\\n  -e ${script} \\\n  -e 's/^B=.*/B=2/' \\\n  .env`, `sed -i ${m} .env`],
    [`sed -i '/^K=/c\\\nK=${value}' .env`, `sed -i ${m} .env`],
    [`sed -i '$a\\\nK=${value}' .env`, `sed -i ${m} .env`],
    [`sed -i 's/^A=.*/A=1/\ns/^K=.*/K=${value}/' .env`, `sed -i ${m} .env`],
    [`perl -pi -e 's/^A=.*/A=1/;\ns/^K=.*/K=${value}/' .env`, `sed -i ${m} .env`],
  ];
  for (const [command, expected] of cases) {
    const session = summaryFor([
      ...callAndResult("Bash", { command, description: "set the key" }, ""),
      { type: "user", message: { role: "user", content: `the key is ${value}` } },
    ]);
    const out = throughCall("Bash", { command, description: "set the key" });
    assert.equal(out.input.command, expected, command);
    assert.ok(!session.lines.join("\n").includes(value), command);
    assert.equal(redactOne(expected), expected, command);
  }

  // What only speaks of an editor, or runs one on something else.
  for (const kept of [
    "git commit -m \"sed -i 's/a/b/' .env\"",
    "cd app && git commit -m \"sed -i 's/a/b/' .env\"",
    "echo \"sed -i 's/a/b/' .env\"",
    "gh pr create --body \"run sed -i 's/a/b/' .env first\"",
    "docker run --env-file .env app sed -i 's/a/b/' /etc/app.conf",
    "find . -name '*.ts' -exec sed -i 's/process.env/x/' {} +",
    "find . -name '*.ts' | xargs sed -i 's/.env/x/'",
    "time sed -i 's/.env/x/' src/a.ts",
    "time sed -i 's/a/b/' src/*.env.ts",
    "ssh host \"sed -i 's/a/b/' /etc/app.conf\"",
    "sed -n '1p' .env | sed -i 's/a/b/' src/a.ts",
    "time sed 's/a/b/' .env",
    "ruby -Ilib x.rb .env",
    "sed -i 's/a/b/' src/a.ts \\\n  src/b.ts",
  ]) {
    assert.equal(throughCall("Bash", { command: kept }, "plain output").input.command, kept);
  }
  assert.deepEqual(shellEditPaths(`sed -i ${m} .env*`, "."), [], "and a glob still names no file to the parse");
});

test("a dotenv file is one however a variable builds its path", () => {
  const m = marker("dotenv");
  const value = "Hy4tN7wB2cQs";
  const write = `echo K=${value} > "$ENV_FILE"`;
  const script = `'s/^K=.*/K=${value}/'`;
  const cases: [string, string][] = [
    // A value in quotes is one word, and what a substitution turns up only says where it starts.
    [`ENV_FILE="$(git rev-parse --show-toplevel)/.env"\n${write}`, `${m} > .env`],
    [`ENV_FILE=$(git rev-parse --show-toplevel)/.env\n${write}`, `${m} > .env`],
    [`ENV_FILE="$(dirname "$0")/.env"\n${write}`, `${m} > .env`],
    [`ENV_FILE="$(dirname "$(realpath "$0")")/../.env.local"\n${write}`, `${m} > ../.env.local`],
    [`ENV_FILE="/srv/My Project/.env"\n${write}`, `${m} > Project/.env`],
    [`ENV_FILE='/srv/My Project/.env'\n${write}`, `${m} > Project/.env`],
    // One variable from another.
    [`A=.env; B=$A\necho K=${value} > "$B"`, `${m} > .env`],
    [`A=.env\nB="\${A}"\necho K=${value} >> "\${B}"`, `${m} > .env`],
    // A default.
    [`echo K=${value} > "\${ENV_FILE:-.env}"`, `${m} > .env`],
    [`echo K=${value} > \${ENV_FILE-.env}`, `${m} > .env`],
    [`echo K=${value} > "\${ENV_FILE:=.env.local}"`, `${m} > .env.local`],
    [`ENV_FILE="\${ENV_FILE:-.env}"\n${write}`, `${m} > .env`],
    // A name that comes from a variable.
    [`echo K=${value} > "$STAGE.env"`, `${m} > $STAGE.env`],
    [`echo K=${value} > "\${STAGE}.env"`, `${m} > \${STAGE}.env`],
    [`echo K=${value} > config/$STAGE.env`, `${m} > config/$STAGE.env`],
    [`echo K=${value} | tee "$STAGE.env"`, `${m} > $STAGE.env`],
    [`F="$STAGE.env"\necho K=${value} > "$F"`, `${m} > $STAGE.env`],
    // And an edit named any of these ways.
    [`sed -i ${script} "$STAGE.env"`, `sed -i ${m} .env`],
    [`sed -i ${script} "\${STAGE}.env"`, `sed -i ${m} .env`],
    [`sed -i ${script} "\${F:-.env}"`, `sed -i ${m} .env`],
    [`A=.env; B=$A; sed -i ${script} "$B"`, `sed -i ${m} .env`],
  ];
  for (const [command, expected] of cases) {
    const session = summaryFor([
      ...callAndResult("Bash", { command }, ""),
      { type: "user", message: { role: "user", content: `the key is ${value}` } },
    ]);
    assert.equal(throughCall("Bash", { command }, "plain output").input.command, expected, command);
    assert.ok(!session.lines.join("\n").includes(value), command);
    assert.equal(throughCall("Bash", { command: expected }, "plain output").input.command, expected, "and a second pass changes nothing");
  }

  // What a variable builds into another file stays, and so does a quote that only closes.
  for (const kept of [
    `F="$(pwd)/a.txt"; echo K=${value} > "$F"`,
    `F="/srv/My Project/a.txt"; echo K=${value} > "$F"`,
    `A=.env; B=a.txt; echo K=${value} > "$B"`,
    `echo K=${value} > "\${F:-a.txt}"`,
    `echo K=${value} > "$STAGE.envelope"`,
    `echo K=${value} > "$STAGE.environment"`,
    `echo "$config.env is not set" > a.txt`,
    `K="$(cat .env)"; echo "$K" > a.txt`,
  ]) {
    assert.equal(throughCall("Bash", { command: kept }, "plain output").input.command, kept);
  }
  assert.equal(
    throughCall("Bash", { command: `echo "a=b" > x; F=.env; echo "K=${value}" > $F` }, "plain output").input.command,
    `${m} > .env`,
  );
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

test("a dotenv file read through an MCP tool leaves nothing in what the tool returned as data", () => {
  const value = "Zq8vR2mK9xLp";
  const dotenv = `DB_HOST=db.internal\nshortpw=hunter2\nmailer_phrase=correct horse battery\nMAILER_PHRASE=${value}\n`;
  const { lines } = summaryFor([
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__fs__read_file", input: { path: ".env" } }] } },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "read" }] }] },
      toolUseResult: [{ type: "text", text: "read" }],
      mcpMeta: { structuredContent: { result: dotenv } },
    },
    { type: "user", message: { role: "user", content: `the phrase is ${value}` } },
  ]);
  const out = lines.join("\n");
  for (const held of ["db.internal", "hunter2", "correct horse battery", value]) assert.ok(!out.includes(held), held);
  assert.deepEqual(Object.keys(JSON.parse(lines[1]!) as object).includes("mcpMeta"), false);
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

test("a command of many statements and a sweep of many values cost what their text is long", () => {
  const timed = (lines: string[]): string[] => {
    const started = performance.now();
    const out = redactLines(lines).lines;
    const took = performance.now() - started;
    assert.ok(took < 5000, `took ${Math.round(took)}ms on ${lines[0]!.slice(0, 60)}…`);
    return out;
  };
  const bash = (command: string): string => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } });
  for (const command of [`${";".repeat(1_000_000)} .env`, `for f in ${";".repeat(1_000_000)} > .env`, `${"&&".repeat(500_000)} .env`, `${"|".repeat(1_000_000)} .env`]) {
    assert.equal(timed([bash(command)]).length, 1);
  }

  const sweep = (values: string[], text: string, times: number): string => {
    const read = callAndResult("Read", { file_path: "/repo/.env" }, values.map((value, i) => `K${i}=${value}`).join("\n")).map((record) => JSON.stringify(record));
    const said = Array.from({ length: times }, () => JSON.stringify({ type: "user", message: { role: "user", content: text } }));
    return timed([...read, ...said]).join("\n");
  };
  const values = Array.from({ length: 500 }, (_, i) => `a${i}b${String(i).padStart(12, "0")}xyz`);
  const out = sweep(values, values.join(" ").repeat(Math.ceil(200_000 / values.join(" ").length)), 100);
  for (const value of values) assert.ok(!out.includes(value), value);
  // Values that start alike, in a text that goes on as they do.
  const alike = Array.from({ length: 500 }, (_, i) => `AAAAAAAA${i}${"A".repeat(i % 50)}xyz`);
  sweep(alike, "A".repeat(200_000), 5);
  sweep(alike, "AAAAAAAA1".repeat(22_000), 5);
});

test("a sweep cuts every learned value wherever it sits, the longest of those that start together", () => {
  const m = marker("dotenv");
  const short = "Zq8vR2mK";
  const long = "Zq8vR2mK9xLpWq7T";
  const inner = "Hy4tN7wB2cQs";
  const outer = "xxHy4tN7wB2cQsyy";
  const escaped = "ab\\cTp3sV8nJ";
  const wide = "пароль-Zq8vR2mK9xLq";
  const dotenv = [`A_PASSWORD=${short}`, `B_PASSWORD=${long}`, `C_PASSWORD=${inner}`, `D_PASSWORD=${outer}`, `E_PASSWORD=${escaped}`, `F_PASSWORD=${wide}`].join("\n");
  const cases: [string, string][] = [
    [short, m],
    [long, m],
    [`${long}${short}${inner}`, `${m}${m}${m}`],
    [`${short}${short}`, `${m}${m}`],
    [`at ${outer} and ${inner}.`, `at ${m} and ${m}.`],
    [`Zq8vR2m ${short.slice(1)} Zq8vR2mK`, `Zq8vR2m ${short.slice(1)} ${m}`],
    [escaped, m],
    [`before ${wide} after`, `before ${m} after`],
    ["nothing learned here", "nothing learned here"],
  ];
  for (const [said, expected] of cases) {
    const { lines } = summaryFor([...callAndResult("Read", { file_path: "/repo/.env" }, dotenv), { type: "user", uuid: "u", message: { role: "user", content: said } }]);
    assert.equal((JSON.parse(lines.at(-1)!) as { message: { content: string } }).message.content, expected);
  }
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
    fill("a://:"),
    fill("a://"),
    fill("a://:b"),
    `redis://:${"a".repeat(200_000)}`,
    `redis://${"a".repeat(200_000)}`,
    `redis://:${fill("a:")}`,
    fill("curl "),
    fill("curl -u "),
    fill("curl -u a "),
    `curl -u ${"a".repeat(200_000)}`,
    `curl -u ${" ".repeat(200_000)}`,
    fill("curl -ku "),
    fill("curl -fsSLu a:"),
    `curl -${"k".repeat(200_000)}`,
    fill(`curl -${"k".repeat(1_000)} `),
    `curl -u '${fill("a:")}`,
    `curl -u 'a:${fill("b ")}`,
    fill("curl -u 'a:b "),
    fill(`curl -u "a:`),
    `curl -u a:'${fill("b ")}`,
    fill("curl -u a:'b "),
    fill("sshpass -p '"),
    `sshpass -p '${fill("b ")}`,
    fill("sshpass -p 'b "),
    fill("mysql -p'a "),
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
    fill("a.pwd"),
    fill("a-pwd "),
    fill("pass: "),
    fill("pass: a"),
    fill("pass:"),
    `pass: ${"a".repeat(200_000)}1`,
    `pass:${" ".repeat(200_000)}a1`,
    fill("auth = "),
    fill("auth ="),
    fill("cookie: a"),
    fill("cookie: a="),
    fill("cookie:a"),
    `cookie: ${"a".repeat(200_000)}=`,
    `cookie: a=${"a".repeat(200_000)}`,
    fill("PASSWORD=a{"),
    fill("PASSWORD=a<"),
    fill("PASSWORD=a{ "),
    fill("password='a{"),
    fill('password="a{'),
    fill("password='a' "),
    fill('password="a" '),
    `PASSWORD=${"a{".repeat(100_000)}`,
    `PASSWORD=a${"{".repeat(200_000)}`,
    `PASSWORD=a${"} ".repeat(100_000)}`,
    `password="${"a'".repeat(100_000)}`,
    `password='${'a"'.repeat(100_000)}`,
    `password="a${"{".repeat(200_000)}`,
    fill('"password": "$'),
    fill('password="$A'),
    fill('password="$a '),
    `password="$${"a".repeat(200_000)}`,
    `password="$${"A".repeat(200_000)}`,
    `password="$${"A".repeat(200_000)}1`,
    `password="$${"a ".repeat(100_000)}1`,
    fill("token=tokens["),
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
    fill("="),
    fill(":"),
    fill("token= "),
    fill("token: "),
    fill('token"=('),
    fill(`${" ".repeat(1_000)}=`),
    fill(`${"s".repeat(1_000)}token=(`),
    fill(`${"s".repeat(1_000)}Token=(`),
    fill(`token${" ".repeat(1_000)}=(`),
    fill(`token=${" ".repeat(1_000)}(`),
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

test("a credential's name is looked for from its separator, so a word with none costs one scan", () => {
  const text = "s".repeat(32_000_000);
  for (const rule of BUILTIN_RULES.filter((candidate) => candidate.type === "assignment")) {
    const started = performance.now();
    applyRules(text, [rule]);
    const took = performance.now() - started;
    assert.ok(took < 1000, `${rule.pattern.source.slice(0, 30)} took ${Math.round(took)}ms`);
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
    `${fill("if ")}.env`,
    `${fill("( ")}.env`,
    `${fill("! ")}.env`,
    `${" ".repeat(200_000)}.env`,
    `cat ${fill("a:")}.env`,
    `cat ${fill(":")}`,
    `cat ${fill(".env ")}`,
    `cat ${fill("a.env ")}`,
    `cat ${"a".repeat(200_000)}.env`,
    `sed -i ${fill("a ")}.env`,
    `sed -i ${fill("s/a/b/ ")}.env`,
    `perl -pi -e ${fill("' ")}.env`,
    `${fill("$(")}.env`,
    `$(${"a".repeat(200_000)}.env`,
    `${fill("$(a ")}.env`,
    `${fill("| ")}.env`,
    `|${" ".repeat(200_000)}.env`,
    `${fill("|xarg")}.env`,
    `echo ${fill(">|")} .env`,
    `sed -i ${fill("s|")} .env`,
    `sed -i ${fill("-s/")} .env`,
    `sed -i ${fill("$a")} .env`,
    `a=b; sed -i ${fill("$a")} .env`,
    `sed -i '${fill("$ ")}' .env`,
    `sed -i '${fill("/a/ ")}' .env`,
    `sed -i '/${"a".repeat(200_000)}' .env`,
    `sed -i '${"1".repeat(200_000)}' .env`,
    `sed -i '${fill("1 ")}' .env`,
    `sed -i '$${" ".repeat(200_000)}' .env`,
    `cat > .env <<EOF\n${fill("$a")}\nEOF`,
    `cat > .env <<EOF\n${fill("a=$a")}\nEOF`,
    `cat > .env <<EOF\n${fill("$a=\n")}EOF`,
    `tail ${"a".repeat(200_000)}`,
    `tail ${"a".repeat(200_000)}.outpu .env`,
    `tail ${fill("a.outpu ")}`,
    `tail ${fill("a.output.")}`,
    `tail ${fill("-")}.output`,
    // Each statement here asks what the whole command assigns.
    fill('echo "$X" > .env\n'),
    fill("sed -i s/$X/b/ .env\n"),
    fill('a=b echo "$X" > .env\n'),
    `${fill("F=.env;")} echo $F > $F`,
    fill("F=.env; echo K=v > $F\n"),
    `for f in ${fill(".env ")}; do echo $f > $f; done`,
    fill("for f in .env; "),
    `${fill("for ")}.env`,
    `for${" ".repeat(200_000)}.env`,
    `for f in${" ".repeat(200_000)}.env`,
    fill("exec 3>.env;"),
    `python3 -c "${fill("open('.env',")}"`,
    `python3 -c "${fill("open(")}.env"`,
    `python3 -c "${fill('open(\\"')}.env"`,
    `python3 -c "${fill("open('.env', mode=")}"`,
    `python3 -c "${fill("open('.env', mode='")}"`,
    `python3 -c "${fill("open('a','")}.env"`,
    `python3 -c "open(\\"${"a".repeat(200_000)}.env"`,
    `${fill("Path('")}.env`,
    `${fill("Path('a')")}.env`,
    `sed -i $${"a".repeat(200_000)} .env`,
    `sed -i ${fill("${a")} .env`,
    `sed -i ${fill("$")} .env`,
    fill("for a  in .env "),
    `open(${" ".repeat(200_000)}.env`,
    `open('.env'${" ".repeat(200_000)}`,
    `python3 -c "open('${"a".repeat(200_000)}.env','w')"`,
    `${fill("writeFileSync('")}.env`,
    fill("Path('.env')"),
    `Path('.env')${" ".repeat(200_000)}`,
    fill("dd of=.env "),
    `dd of=${"a".repeat(200_000)}.env`,
    `cp ${fill("a ")}/dev/stdin .env`,
    `${fill("cp /dev/stdin\n")}.env`,
    `${fill("cp a\n")}.env`,
    `awk -i${" ".repeat(200_000)}inplace .env`,
    `ruby ${fill("-a ")}.env`,
    `bash <<SH\n${fill("echo K=v > .env\n")}SH`,
    `echo ${fill("K=v;")} > .env`,
    `echo ${fill("K=a>")}.env`,
    `echo K=${fill("a;")}>.env`,
    `echo K=${"a".repeat(200_000)}>.env`,
    `${fill("K=aZ9bY8cX7;\n")}>.env`,
    `${fill("tee '")} .env`,
    // Each heredoc here looks for where it ends.
    `${fill("cat <<a\na\n")}.env`,
    `${fill("cat > .env <<a\na\n")}`,
    `cat <<a\n${"\n".repeat(200_000)}a\n.env`,
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
    fill("A=;"),
    `A=${fill(";")}`,
    `A=${fill("a-")}!`,
    `A=${fill("a_b")}`,
    `A=${fill("a/")}!`,
    `A=${fill("a.")} `,
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

test("a backslash outside quotes opens no quote, so a dotenv write behind one is still cut", () => {
  const value = "Zq8vR2mK9xLp4T";
  const m = marker("dotenv");
  const cases: [string, string][] = [
    [`echo APP_KEY=\\"${value}\\" > .env`, `${m} > .env`],
    [`echo APP_KEY=\\"${value}\\" >> .env.local`, `${m} > .env.local`],
    [`echo APP_KEY=\\"${value}\\" | tee .env`, `${m} > .env`],
    [`echo don\\'t; echo "APP_KEY=${value}" > .env`, `echo don\\'t; ${m} > .env`],
    [`echo "C:\\\\"; echo "APP_KEY=${value}" > .env`, `echo "C:\\\\"; ${m} > .env`],
  ];
  for (const [command, expected] of cases) {
    const { lines } = summaryFor([
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } },
      { type: "user", message: { role: "user", content: `the key is ${value}` } },
    ]);
    const [call, later] = lines.map((line) => JSON.parse(line) as { message: { content: { input: { command: string } }[] & string } });
    assert.equal(call!.message.content[0]!.input.command, expected);
    assert.equal(later!.message.content, `the key is ${m}`);
  }
  // Escaped, it is no redirect at all; in quotes, it is what a message says.
  for (const command of [`echo \\> .env`, `git commit -m "x > .env"`, `git commit -m "don't > .env"`]) {
    assert.equal(throughCall("Bash", { command }, "plain output").input.command, command);
  }
});

test("a variable naming a dotenv file, used all over a command, costs no more than the command is long", () => {
  for (const command of [
    `F=${"a".repeat(1000)}.env; echo ${"$F ".repeat(66_000)}`,
    `F=${"a".repeat(8000)}.env; echo ${"$F ".repeat(24_000)}`,
    `F=${"a".repeat(100_000)}.env;${"$F;".repeat(33_000)}`,
    `F=${"a".repeat(100_000)}.env; echo ${"$F ".repeat(33_000)}`,
    `F=${"a".repeat(250)}.env;${"$F;".repeat(66_000)}`,
  ]) {
    const started = performance.now();
    const { lines } = redactLines([JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } })]);
    const took = performance.now() - started;
    assert.equal(lines.length, 1);
    assert.ok(took < 5000, `took ${Math.round(took)}ms on ${command.slice(0, 12)}…`);
  }
  assert.equal(throughCall("Bash", { command: "F=.env; echo K=Zq8vR2mK9xLp > $F" }, "plain output").input.command, `${marker("dotenv")} > .env`);
});

test("a run of millions of characters costs the text it sits in, not the session", () => {
  const size = 8_000_000;
  for (const text of [
    `Authorization: ${"a".repeat(size)}`,
    `authorization=${"a".repeat(size)}`,
    `Authorization: Bearer ${"QUJD+/==".repeat(size / 8)}`,
    `Cookie: ${"a=b; ".repeat(size / 5)}`,
    `password=${"a".repeat(size)}`,
    `sk-${"a".repeat(size)}`,
    `/home/x/${"a/".repeat(size / 2)}`,
  ]) {
    const { lines, summary } = redactLines([
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: text }] } }),
      `not json: ${text}`,
    ]);
    const content = (JSON.parse(lines[0]!) as { message: { content: { content: string }[] } }).message.content[0]!.content;
    assert.equal(content, marker("oversized"), text.slice(0, 24));
    assert.equal(lines[1], marker("oversized"), text.slice(0, 24));
    assert.equal(summary.counts.oversized, 2);
  }
});

test("a dotenv read's result is learned from and cut however deep it nests", () => {
  const depth = 200_000;
  const { lines } = redactLines([
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/.env" } }] } }),
    `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":${"[".repeat(depth)}"MAILER_PHRASE=Zq8vR2mK9xLp"${"]".repeat(depth)}}]}}`,
    JSON.stringify({ type: "user", message: { role: "user", content: "the phrase is Zq8vR2mK9xLp" } }),
  ]);
  assert.equal((JSON.parse(lines[1]!) as { message: { content: { content: string }[] } }).message.content[0]!.content, marker("dotenv"));
  assert.equal((JSON.parse(lines[2]!) as { message: { content: string } }).message.content, `the phrase is ${marker("dotenv")}`);
});

test("a line too dear to parse is cut whole, and so is what comes past the session's limit", () => {
  const blocks = (count: number) => JSON.stringify({ type: "user", x: Array(count).fill({}) });
  const one = redactLines([blocks(4_000_001), JSON.stringify({ type: "user", uuid: "after" })], { home: "/home/u" });
  assert.equal(one.lines[0], marker("oversized"));
  assert.equal(JSON.parse(one.lines[1]!).uuid, "after", "a line of its own does not take the rest with it");

  const many = redactLines(Array.from({ length: 5 }, () => blocks(1_000_000)), { home: "/home/u" });
  assert.deepEqual(many.lines.map((line) => line === marker("oversized")), [false, false, false, true, true]);
  assert.equal(many.summary.counts.oversized, 2);
});
