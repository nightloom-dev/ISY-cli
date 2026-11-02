import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileLines } from "./lines.js";
import { type Budget, HEREDOC, STRUCTURES, commandSegments, mayParse, shellEditWords, spend, withoutHeredocs } from "./parser.js";
import {
  PATH_KEYS,
  REDACTION_MARKER,
  looksAbsolute,
  marker,
  maskPath,
  maskPaths,
  resolveRoots,
  rootOf,
} from "./mask-paths.js";
import type { MaskRoots, PreparedRoots } from "./mask-paths.js";

// The marker vocabulary lives with the path rules, which cannot import this
// module back without a cycle. Re-exported so every caller has one import.
export { REDACTION_MARKER, marker };

export interface RedactionRule {
  type: string;
  pattern: RegExp;
  replacement: string;
}

/** `[pP][aA]…`: case by hand, so a rule can still tell a camelCase hump from a glued prefix. */
function anyCase(source: string): string {
  return source.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

/**
 * `pass` and `pwd` count only as a word of their own, as `compass`, `bypass`, and the
 * shell's `PWD` and `OLDPWD` are all over a transcript: `DB_PASS`, `db-pass`, `dbPass`,
 * `DB_PWD`, `jdbc.pwd`, `Uid=sa;Pwd=…`, and `Pwd=…` as only a connection string spells it.
 */
const SECRET_WORD = [
  anyCase("pass(?:word|wd|phrase)|secret|token|(?:api|private|access|account)[-_]?key|credentials?|auth(?:orization)?|cookie"),
  `(?:(?<![A-Za-z0-9])|(?<=[a-z0-9])(?<![bB][yY])(?=[A-Z]))${anyCase("pass")}`,
  `(?:(?<=[;_]|[A-Za-z0-9][.-])|(?<=[a-z0-9])(?=[A-Z]))${anyCase("pwd")}`,
  "(?<![A-Za-z0-9])Pwd",
].join("|");

/** What is still the secret itself: its value, and the environment it is for. */
const SAME_SECRET = "value|prod(?:uction)?|dev|stag(?:e|ing)|test|live|old|new|local";
const KEY_OR_BASE = "(?:[-_]?key)?(?:[-_]?base)?";
/** Its version too, short of a year: `token_2022` names a chain's program and holds nothing. */
const VERSION = "[0-9]{1,3}";
/** `TOKEN_PROD`, `secret-old`, `API_KEY_2`. */
const PLAIN_TAIL = anyCase(`${KEY_OR_BASE}(?:[-_](?:${SAME_SECRET}))?(?:[-_]${VERSION})?`);
/** `tokenValue`, `apiKeyProd`, and `accessToken2`, as `token0` and `oauth2` are no secrets. The cap keeps a run of `token1` linear. */
const HUMP_TAIL = anyCase(`${KEY_OR_BASE}(?:[-_]?(?:${SAME_SECRET}))?`) + `(?:(?:[-_]|(?<=[a-z0-9][A-Z][A-Za-z0-9]{0,64}))${VERSION})?`;

/**
 * A name that holds a secret: one of the words, wherever it sits in an
 * identifier — `PGPASSWORD`, `STRIPE_SECRET_KEY`, `aws_secret_access_key`,
 * `x-api-key` — and followed by nothing but `KEY` and `BASE` (`SECRET_KEY_BASE`)
 * and what is still the secret. That tail is the line between the secret and what
 * is said about it: `tokenHash`, `max_tokens`, `TOKENS_PER_ANALYSIS` and
 * `PASSWORD_FILE` turn up in a real corpus as often as the secrets do, and none of
 * them is one.
 */
function secretName(atWord = "", tail = HUMP_TAIL): string {
  // From the front this runs at every character of a word, so the letters the words start with go first.
  return String.raw`[A-Za-z0-9_.-]*?(?=[aAcCpPsStT])${atWord}(?:${SECRET_WORD})${tail}(?![A-Za-z0-9_.-])`;
}

/** `adminPassword`, `_authToken`, `tokenValue`: as often a variable in code as a key in a file, and told by a hump. */
const CAMEL_NAME = secretName() + "(?<=[a-z0-9][A-Z][A-Za-z0-9_.-]*)";
/** `accessToken: …`, which a value in no quotes leaves to be a type as often as data. */
const CAMEL_ENDING = String.raw`[A-Za-z0-9_.-]*?(?<=[a-z0-9])(?:Token|Secret|Password)`;

/**
 * `First pass: everything compiles`, `--- PASS: TestParser`, `auth: requireAuth`,
 * `const cookie = parseCookie(req)`: alone, these words are all over prose, code and
 * test output, so alone and spaced from a value with no digit and no quote they name
 * nothing. A secret has a name in front (`SMTP_PASS: …`), a quote or a digit, or
 * takes its `=` with no space.
 */
const NOT_SAID_IN_PASSING = String.raw`(?!PASS:[ \t]|(?:${anyCase("pass|auth|credentials?|cookie")})["']?\s*[=:]\s+(?!["'])[^\d\s]*(?:\s|$))`;
/** The word glued to what came before, but not as a camelCase hump. */
const PLAIN_NAME = NOT_SAID_IN_PASSING + secretName("(?!(?<=[a-z0-9])[A-Z])", PLAIN_TAIL);

const VALUE_CHAR = String.raw`[^\s"'{}()[\]<>$]`;
/**
 * `hash(input)`, `foo.bar(baz).qux(),`, `f(g(x))`: a call, which in quotes is a password
 * with a bracket in it, and so is `abc(def)ghi1` anywhere, as code puts nothing like that
 * after a closing bracket.
 */
const CALL = String.raw`(?<!["'])[A-Za-z_][\w.]*\((?![^\s"'{}[\]<>]{0,256}\)[\w$#@~\\])`;

/**
 * What an assigned secret looks like: long enough to be one, and not code. A
 * bare number under a quoted name is JSON's own (`"token": 1234567890`), where a
 * secret would be a string; anywhere else a number is a password like any other
 * — `DB_PASSWORD=1234567890123`, `MYSQL_ROOT_PASSWORD: 12345678`. The digit is
 * looked for first so the lookbehind runs only where a number starts.
 *
 * A `$` or a bracket inside belongs to the value (`abc$REST123`, `abc(def)ghi1`), as
 * a password takes any character. They end it only where they start something
 * else: `$PASSWORD` and `$(cat f)` at the front, `prefix${X}`, and a call, of which
 * only a name long enough to be a value goes.
 *
 * How much more a value takes goes by what is around it. In quotes it runs to the
 * closing one, the other quote and `{}[]<>` included, though what opens with a
 * bracket is a placeholder; `$` at the front is literal in single quotes, and in
 * double ones where no shell would expand it: a hash, or anything with a digit in it
 * that no all-caps name spells. With no space after an `=` it takes `{}[]<>` too,
 * short of one closing around the assignment. Spaced from its name and unquoted it is
 * code as often as not (`token = tokens[index]`), so the limits above hold there.
 */
const INNER_DOLLAR_OR_PAREN = String.raw`[$()](?=[^\s"'{}[\]<>])`;
const LITERAL_DOLLAR = String.raw`\$(?=[^\s"]{0,256}\d)(?![{(])(?![A-Z_][A-Z0-9_]*\b)`;
const SECRET_VALUE = String.raw`(?!\[ISY_REDACTED)(?!(?=-?\d)(?<=["']\s*:\s*)-?\d[\d.,eE+-]*(?![^\s"'{}()[\]<>$]))(?:(?<=")(?:${VALUE_CHAR}|${LITERAL_DOLLAR})(?:[^\s"$()]|${INNER_DOLLAR_OR_PAREN}){7,}|(?<=')(?:${VALUE_CHAR}|\$)(?:[^\s'$()]|${INNER_DOLLAR_OR_PAREN}){7,}|(?<=[\w.-]=)(?!=|${CALL})${VALUE_CHAR}(?:${VALUE_CHAR}|${INNER_DOLLAR_OR_PAREN}|[{}[\]<>](?=[^\s"'])){7,}|(?!${CALL})${VALUE_CHAR}(?:${VALUE_CHAR}|${INNER_DOLLAR_OR_PAREN}){7,}|${VALUE_CHAR}{8,})`;
/**
 * A value read to a space or a quote can end on the name of the next one: `Set-Cookie:
 * session_token="…"`, `DB_PASS=DB_PASSWORD="…"`, `auth-cookie: api_key= …`. That name is then
 * inside the match, where no rule after it looks, so the match goes on through the name's
 * separator and over what it holds, as the name's own would have, closing quote and all, and
 * again where that ends on a name. The rules after the plain assignment find such a name cut
 * already, by its own match there, so only that rule and the authorization rule ahead of it go on.
 *
 * ponytail: the name is told by the word it ends with, as a copy of secretName() in both would
 * take the patterns past the size a commit compiles in time (the size test in redact.test.ts),
 * so what a name ending otherwise holds (`DB_PASS`, `TOKEN_PROD`) stays. Telling the name
 * outside the pattern, once a match is found, is the way up.
 */
const RUNS_ON = String.raw`(?:(?<=${anyCase("(?:passw(?:or)?d|secret|token|key|base)")}["']?[=:]?)(?:(?<=[=:])|["']?\s*[=:])\s*(?<q>["']?)${VALUE_CHAR}{8,}\k<q>?)*`;

/**
 * A separator with a name before it, looked for from the separator back: from the front,
 * a name costs a look at every letter of every word.
 */
const afterName = (name: string, between: string, separator: string): string => String.raw`${separator}(?<=(?<![A-Za-z0-9_.-])${name}${between}${separator})`;
/** The space or quote a name may have before its separator. */
const CLOSED = String.raw`["']?\s*`;
/**
 * `=>`, `:=`, a comparison and a subscript's `"] =`: what is code as often as data
 * (`password => password.trim()`), unless what follows is in quotes. A run of `=` is
 * looked back from only where it starts, as no name stands right before the rest of it.
 */
const beforeQuoted = (name: string): string => afterName(name, String.raw`["']?\]?\s*`, "(?:=>|:=|(?<!=)={1,3}|!={1,2})") + String.raw`\s*["']`;

/** What nobody types by hand: twelve letters and digits in a row, both among them, as `documentation` and `202410201230` are not. */
const GENERATED_RUN = String.raw`(?=[A-Za-z]{0,11}\d)(?=\d{0,11}[A-Za-z])[A-Za-z0-9]{12}`;
const GENERATED = new RegExp(GENERATED_RUN);
/** `STRIPE_KEY`, `HMAC_KEY`: as often a sort order as a secret (`SORT_KEY=created_at`), so what it holds has to look generated too. */
const KEY_NAME = String.raw`(?:[A-Z][A-Z0-9_]{0,64}_)?KEY`;
const KEY_FIELD = new RegExp(`^${KEY_NAME}$`);
const KEY_END = String.raw`KEY(?<=(?<![A-Za-z0-9_])${KEY_NAME})`;

/**
 * `curl -u admin:…`, its flag alone or last among others (`-fsSLu`). A walk to the flag
 * stops at the next `curl`, which finds the same from there, so the walks of a line come
 * to about its length however often it says `curl`. The cap says how far a flag is still
 * this client's.
 */
const CURL_USER_FLAG = String.raw`curl\b(?:(?!\bcurl\b)[^\n;|]){0,200}?\s(?:-[a-zA-Z]{0,16}[uU]\s*|--(?:proxy-)?user[=\s]\s*)`;
/** A name may be a marker already: an address is one by now. */
const CURL_USER = String.raw`(?:\[ISY_REDACTED:\w+\]|(?!\[ISY_REDACTED)[^\s:"']+):`;
/**
 * A client, whatever comes between, and its flag: stopped and capped as above, at a start
 * as `PASSWORD_FLAG` has it.
 *
 * ponytail: the walks come to a line's length for each client it names, so a line naming
 * every one of them in turn costs ten times a plain one. Finding each client's flags once,
 * outside the pattern, is the way up if a stranger's session makes that matter.
 */
const onClient = (client: string, flag: string): string => String.raw`(?:${client})\b(?:(?!\b(?<![.-])(?:${client})\b)[^\n;|]){0,200}?\s${flag}`;
/** The next word looks generated, for where what stands in front of it says too little. */
const GENERATED_WORD = String.raw`(?=["']?[^\s"'/]{0,256}?${GENERATED_RUN})`;
/**
 * Where a client takes a password, which says nothing anywhere else: `-p` is a port to
 * `ssh`, a directory's parents to `mkdir`, and to `mysql` with a space after it only a
 * prompt. A name after `.` or `-` is a file's or another tool's (`wget a.zip -P out`),
 * and `--name mongo -p 27017:27017` is a container, so to that family `-p` counts
 * behind `-u`. What a here-string feeds is anyone's, so that word has to look generated.
 *
 * A walk that a text can start again and again stops where the next one starts, which
 * finds the same from there: a text of `mongo -u a ` is otherwise thousands of steps for
 * each word in it, and a text of `<` hundreds for each character. A `-u` with `-p` for its
 * name finds nothing from there, so that one is walked through.
 *
 * ponytail: the clients people use. Another tool's own flag stays, as it does anywhere,
 * unless a project's own script (`./x`) gets something generated on one of these flags.
 */
const USER_FIRST = "mongosh|mongo|mongodump|mongorestore|mongoexport|mongoimport|cqlsh";
const USER_FLAG = String.raw`\s(?:-u|--username)[=\s]`;
const PASSWORD_FLAG = String.raw`(?:\b(?<![.-])(?:${[
  onClient("sshpass", String.raw`-p\s*`),
  onClient(String.raw`(?:docker|podman)\s+login|helm\s+registry\s+login|az\s+login|twine\s+upload`, String.raw`-p\s+`),
  String.raw`(?:${USER_FIRST})\b(?:(?!\b(?<![.-])(?:${USER_FIRST})\b)[^\n;|]){0,200}?${USER_FLAG}\s*\S+(?!\S)(?:(?!${USER_FLAG}(?!\s*-p\s))[^\n;|]){0,200}?\s-p\s+(?!\d+:\d)`,
  onClient("redis-cli", String.raw`-a\s+`),
  onClient("mysql|mariadb|mysqldump|mysqladmin|7z|7za|7zz", String.raw`-p(?=[^\s=])`),
  onClient("sqlcmd|bcp|zip|unzip", String.raw`-P\s*`),
  onClient("plink|pscp|psftp", String.raw`-pw\s+`),
  onClient("ssh-keygen", String.raw`-N\s+`),
  onClient("lftp", String.raw`-u\s+["']?[^\s,"']+,`),
  onClient("smbclient", String.raw`-U\s+["']?[^\s%"']+%`),
  onClient(String.raw`(?:https?|xh)(?=\s)`, String.raw`(?:-a|--auth)[=\s]\s*["']?[^\s:"']+:`),
  onClient("curl", String.raw`(?:-[a-zA-Z]{0,16}b|--cookie)[=\s]\s*(?=["']?[^\s"'=]{1,256}=)`),
  onClient("rabbitmqctl", String.raw`(?:add_user|change_password)\s+\S+\s+`),
  onClient(String.raw`gh\s+secret\s+set`, String.raw`(?:-b|--body)[=\s]\s*`),
  onClient(String.raw`doctl\s+auth\s+init`, String.raw`(?:-t|--access-token)[=\s]\s*`),
  onClient(String.raw`security\s+add-\w+-password`, String.raw`-w\s+`),
  String.raw`htpasswd\s+(?=-[a-zA-Z]*b)(?:-[a-zA-Z]*n[a-zA-Z]*\s+\S+\s+|-[a-zA-Z]+\s+\S+\s+\S+\s+)`,
  String.raw`sqlplus\s+(?:-\S+\s+)*[^\s/@"'-][^\s/@"']*\/`,
  // Not a second `smbclient`, which is the next command's: `apt install smbclient && smbclient -U a%b`.
  String.raw`smbclient\s+[^\s-]\S*\s+(?!smbclient\b)`,
  String.raw`net\s+use\s+(?:\S+\s+){1,2}\/user:\S+\s+`,
  String.raw`vault\s+login\s+${GENERATED_WORD}`,
  String.raw`ngrok\s+(?:config\s+add-)?authtoken\s+`,
  String.raw`(?:poetry|composer)\s+config\s+(?:--\S+\s+)*(?:http-basic\.\S+\s+\S+|pypi-token\.\S+)\s+`,
  String.raw`(?:aws\s+configure\s+set|(?:npm|yarn|wp)\s+config\s+set|setx|setenv|set\s+-[a-z]*x[a-z]*)\s+(?:\S*[/:])?${secretName()}\s+`,
  String.raw`SetEnvironmentVariable\(\s*["']${secretName()}["']\s*,\s*`,
  String.raw`echo\s+(?:-n\s+)?(?=["']?[^\s"']{1,400}["']?\s*\|[^\n;|]{0,200}?--(?:password-stdin|with-token)\b)`,
].join("|")})|-(?<=\s-)(?:(?:src|dest)?(?:store|key)pass\s+|Dsonar\.login=)|<<<\s*(?=["']?(?:(?!<<<)[^\s"'/]){0,256}?${GENERATED_RUN})|\.\/[\w.-](?:(?!\.\/[\w.-])[^\n;|]){0,263}?\s(?:-p|--key|--pwd)\s+${GENERATED_WORD})`;
/** To a closing quote named by the backreference `quote`, spaces and the other quote included. */
const quotedTo = (quote: string): string => String.raw`(?!\[ISY_REDACTED|\$)(?:(?!${quote})[^\n]){1,400}(?=${quote})`;

export const BUILTIN_RULES: RedactionRule[] = [
  {
    type: "private_key",
    // `BLOCK` is how PGP armors one.
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replacement: marker("private_key"),
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: marker("jwt"),
  },
  {
    type: "anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replacement: marker("anthropic_key"),
  },
  {
    type: "openai_key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: marker("openai_key"),
  },
  {
    type: "github_token",
    pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/g,
    replacement: marker("github_token"),
  },
  {
    type: "github_token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: marker("github_token"),
  },
  {
    type: "aws_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: marker("aws_key"),
  },
  {
    type: "google_key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replacement: marker("google_key"),
  },
  {
    // Secret and restricted keys; `pk_` is publishable by design.
    type: "stripe_key",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacement: marker("stripe_key"),
  },
  {
    type: "slack_token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replacement: marker("slack_token"),
  },
  {
    type: "npm_token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: marker("npm_token"),
  },
  {
    // One pass for all of them, as a rule each is one more scan of every string: GitLab, Slack,
    // Discord, Groq, xAI, Google's OAuth, Stripe's webhooks, SendGrid, Mailgun, Twilio, Shopify,
    // DigitalOcean, Hugging Face, PyPI, RubyGems, Docker, Supabase, Vercel, Atlassian, Linear,
    // Notion, Figma, Replicate, ElevenLabs, age. A fal.ai key, and a Telegram or a Discord bot
    // token, open with an id that is public and whose shape would be read at every word of
    // every string, so they are found from what comes after it and the id stays.
    type: "service_token",
    pattern: new RegExp(
      String.raw`\b(?:gl(?:pat|dt)-[\w-]{20,}|xapp-\d-[A-Za-z0-9-]{20,}|hooks\.slack\.com\/\w+\/[\w/]{20,}|discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{40,}` +
        String.raw`|gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|ya29\.[\w-]{40,}|1\/\/0[\w-]{40,}|whsec_[A-Za-z0-9+/]{24,}|SG\.[\w-]{16,}\.[\w-]{16,}` +
        String.raw`|key-[0-9a-f]{32}\b|SK[0-9a-f]{32}\b|shp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b|do[pors]_v1_[0-9a-f]{64}\b|hf_[A-Za-z0-9]{30,}|pypi-[\w-]{50,}` +
        String.raw`|rubygems_[0-9a-f]{48}\b|dckr_pat_[\w-]{20,}|sbp_[0-9a-f]{40}\b|vercel_[A-Za-z0-9]{20,}|ATATT[\w-]{50,}|lin_api_[A-Za-z0-9]{30,}` +
        String.raw`|ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,}|figd_[\w-]{30,}|r8_[A-Za-z0-9]{30,}|sk_[0-9a-f]{48}\b|AGE-SECRET-KEY-1[A-Z0-9]{50,})` +
        String.raw`|:(?<=\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:)[0-9a-f]{32}\b|:(?<=\b\d{8,12}:)AA[\w-]{30,}` +
        String.raw`|\.(?<=[\w-]{24}\.)[\w-]{6}\.(?=[\w-]{0,26}?${GENERATED_RUN})[\w-]{27,}`,
      "g",
    ),
    replacement: marker("service_token"),
  },
  {
    // After every shape a bearer token can have, so a JWT or a GitHub token
    // keeps its own label and its marker is not marked again. Twenty characters
    // for a word alone, or eight with a digit: `Bearer authentication` is prose.
    type: "bearer_token",
    pattern: /\b(Bearer\s+)(?!\[ISY_REDACTED)(?:(?=[A-Za-z._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}|[A-Za-z0-9._~+/-]{20,})=*/gi,
    replacement: `$1${marker("bearer_token")}`,
  },
  {
    // Whatever the scheme (`Basic`, `Token`, `Digest`): the header says what the
    // word after it is, so it needs no shape. Before the assignment rule, which
    // would stop at the scheme. A variable or a placeholder is left as it is.
    type: "authorization",
    pattern: new RegExp(/\b(authorization["'`]?[ \t]*[:=][ \t]*["'`]?[A-Za-z][A-Za-z0-9-]*[ \t]+)(?!\[ISY_REDACTED)[^\s"'`$<>{}()[\]]{8,}/.source + RUNS_ON, "gi"),
    replacement: `$1${marker("authorization")}`,
  },
  {
    // Any scheme: a password in a URL is one whatever speaks it — rediss,
    // amqps, https to a bare IP. The scheme is capped because `\b` lets a match
    // start inside a dotted or dashed run: unbounded, every start rescans the
    // rest of the run, and a long one costs minutes. The user may be empty, as
    // Redis URLs usually write it: `redis://:password@host`.
    type: "connection_string",
    pattern: /\b([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^\s:/@]*):([^\s/@]+)@/g,
    replacement: `$1://$2:${marker("connection_string")}@`,
  },
  {
    // After the connection string: its password sits right before an `@` too.
    // Starts only where a run of local-part characters starts: with `\b`, every
    // dot, dash and `%` in a run began a new scan of the rest of it, and a
    // version list or a URL-encoded query took minutes to get through.
    type: "email",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
    replacement: marker("email"),
  },
  {
    // The name may close a quote of its own: `"password": "…"`.
    type: "assignment",
    pattern: new RegExp(String.raw`(${afterName(PLAIN_NAME, CLOSED, "[=:]")}\s*["']?|${beforeQuoted(PLAIN_NAME)})${SECRET_VALUE}${RUNS_ON}`, "g"),
    replacement: `$1${marker("assignment")}`,
  },
  {
    // A camelCase name counts where it is plainly data — with a quoted value
    // (`accessToken: "…"`), as `name=value` with no space, as `.npmrc` writes
    // `_authToken=`, or as a log prints one when what it holds looks generated
    // (`accessToken: aB3…`) — and not in `adminPassword = someVariable`. One look for
    // `=` and `:`, as a commit compiles every copy of a name in here again.
    type: "assignment",
    pattern: new RegExp(String.raw`(${afterName(CAMEL_NAME, String.raw`(?:(?=[=])|${CLOSED}(?=:))`, "[=:]")}(?:(?<==)|\s*["'])|${beforeQuoted(CAMEL_NAME)}|${afterName(CAMEL_ENDING, "", ":")}[ \t]+(?=[^\s"']{0,256}?${GENERATED_RUN}))${SECRET_VALUE}`, "g"),
    replacement: `$1${marker("assignment")}`,
  },
  {
    // What SQL, `.netrc` and XML have for a separator. `password '…'` only in single quotes,
    // as SQL writes it, since `grep password "src/auth"` names none; a tag only with its
    // close, since `bot<token>/getUpdates` is a placeholder.
    type: "assignment",
    pattern: new RegExp(
      String.raw`(\b${anyCase("password")}\s+(?:${anyCase("for")}\s+\S{1,256}\s*=\s*)?'|\b${anyCase("identified")}\s+(?:${anyCase("with")}\s+\S{1,64}\s+)?${anyCase("by")}\s+["']|\bmachine\s+\S{1,256}\s+login\s+\S{1,256}\s+password\s+["']?)${SECRET_VALUE}` +
        String.raw`|(<${secretName()}>)${SECRET_VALUE}(?=<\/)`,
      "g",
    ),
    replacement: `$1$2${marker("assignment")}`,
  },
  {
    // What signs a URL, up to its next parameter.
    type: "assignment",
    pattern: new RegExp(String.raw`([?&](?:[xX]-(?:${anyCase("amz")}|${anyCase("goog")})-)?${anyCase("sig")}(?:${anyCase("nature")})?=)(?!\[ISY_REDACTED|\$)[^\s&"'#]{8,}`, "g"),
    replacement: `$1${marker("assignment")}`,
  },
  {
    // `--password hunter2000`, `--api-key "…"`: a name like any other, with a
    // space where `=` goes. `--password-file /x` has a tail no secret's name has,
    // and what starts with a dash is the next flag.
    type: "assignment",
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(-${secretName()})([ \t]+)(["']?)(?!-)${SECRET_VALUE}`, "g"),
    replacement: `$1$2$3${marker("assignment")}`,
  },
  {
    // From the word back to the name, as the name from its front is a scan at every capital.
    // The word is looked through as far as the next such name, which looks on from there.
    type: "assignment",
    pattern: new RegExp(String.raw`${KEY_END}(["']?\]?\s*[=:]\s*["']?)(?=(?:(?!${KEY_END}\]?[=:])[^\s"']){0,256}?${GENERATED_RUN})${SECRET_VALUE}`, "g"),
    replacement: `KEY$1${marker("assignment")}`,
  },
  {
    // A cookie header's value runs to the end of the line, spaces and `;` included, or to a quote.
    // It opens with a name and `=`, which `cookie == null` and `cookie = jar.get()` do not.
    //
    // After every rule that goes by a name, as this one takes whatever stands in its way:
    // ahead of them, `--cookie=k=v --password='…'` lost the name and kept what it named. So its
    // first pair may be a marker by now, and what follows still goes.
    type: "cookie",
    pattern: /\b(cookie["'`]?[ \t]*[:=][ \t]*["'`]?)(?:(?!\[ISY_REDACTED)(?=[^\s"'`=;,$<{]{1,256}=[^=])|(?=\[ISY_REDACTED:\w+\][ \t]*[^\s"'`]))[^"'`\r\n]{8,}/gi,
    replacement: `$1${marker("cookie")}`,
  },
  {
    // The quote opens before the name or after its colon, and only one of the two
    // groups takes part, so together they are that one quote.
    type: "assignment",
    pattern: new RegExp(String.raw`\b(${CURL_USER_FLAG}(?:(["'])${CURL_USER}|${CURL_USER}(["'])))${quotedTo(String.raw`\2\3`)}`, "g"),
    replacement: `$1${marker("assignment")}`,
  },
  {
    type: "assignment",
    pattern: new RegExp(String.raw`\b(${CURL_USER_FLAG}["']?${CURL_USER})(?!\[ISY_REDACTED)[^\s"'$][^\s"']*`, "g"),
    replacement: `$1${marker("assignment")}`,
  },
  {
    // One pass for both spellings, as each is a scan of every word for every client.
    //
    // ponytail: one pass over the text, as a second doubles what any text with a password
    // costs and goes over all it grew by. So a flag's second use stays (`curl -b k=a -b j=b`),
    // and so does a flag a match of another kind took the way to: `ssh-keygen -t rsa && curl
    // -N https://x -b k=b` loses `curl` to `-N`, `plink a mysql plink -pw b` loses `-pw` to
    // `-p`. Tracking each client's flags outside the pattern is the way up.
    type: "assignment",
    pattern: new RegExp(String.raw`(${PASSWORD_FLAG})(?:(["'])${quotedTo(String.raw`\2`)}|(["']?)(?!\[ISY_REDACTED|(?<=\s)-)[^\s"'$][^\s"']*)`, "g"),
    replacement: `$1$2$3${marker("assignment")}`,
  },
];

/** A JSON key is data, never code, so any spelling of a secret's name counts. */
const SENSITIVE_KEY = new RegExp(`^${secretName()}$`);
const MIN_SENSITIVE_VALUE = 8;
const EDIT_INPUT_FIELDS = ["content", "old_string", "new_string", "new_source"];

export interface RedactionSummary {
  counts: Record<string, number>;
  replacements: number;
  lines: number;
  unparsedLines: number;
  invalidExtraPatterns: string[];
}

interface RedactContext {
  rules: RedactionRule[];
  counts: Record<string, number>;
  envToolUseIds: Set<string>;
  /** The last `!` command typed in Claude Code read or wrote a dotenv file. */
  bashInputTouchedDotenv: boolean;
  /** What dotenv files held, as far as the session showed them (`learnValues`). */
  learned: Set<string>;
  structures: Budget;
  dotenvCommands: Budget;
  added: Budget;
  /**
   * Mutable: a transcript names its own working directory on every record, so a
   * caller that did not pass one still gets repository-relative paths. The
   * first record that carries one wins — a session that wanders between
   * directories is judged from where it started.
   */
  roots: PreparedRoots;
  /** What a relative name in a path field is relative to, when not the root. */
  base?: string;
  /** Whether the working directory was given rather than read off a record. */
  rootGiven: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(context: RedactContext, type: string, amount: number): void {
  context.counts[type] = (context.counts[type] ?? 0) + amount;
}

export function compileExtraRules(
  patterns: readonly string[] | undefined,
  invalid: string[],
): RedactionRule[] {
  const rules: RedactionRule[] = [];
  for (const source of patterns ?? []) {
    try {
      rules.push({ type: "custom", pattern: new RegExp(source, "g"), replacement: marker("custom") });
    } catch {
      invalid.push(source);
    }
  }
  return rules;
}

export function applyRules(
  text: string,
  rules: readonly RedactionRule[],
  onMatch?: (type: string, amount: number) => void,
): string {
  let result = text;
  for (const rule of rules) {
    const matches = result.match(rule.pattern);
    if (!matches) continue;
    onMatch?.(rule.type, matches.length);
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/** `NAME=value` as a dotenv file or a shell write spells it; code puts spaces round its `=`. */
const DOTENV_PAIR = /(?<![\w.$-])([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;
/** A line that is one value and nothing else: `cut -d= -f2 .env`, `node -p process.env.X`. */
const BARE_VALUE = /^[^\s"'{}[\]<>=]+=*$/;
/** A word or a number: `password`, `changeme`, `production` and `12345678` are all through normal text. */
const PLAIN_WORD = /^(?:[A-Z]?[a-z]+|[A-Z]+|\d+)$/;
const MIN_LEARNED_VALUE = 12;
/** ponytail: a session names far fewer. The first ones win. */
const MAX_LEARNED_VALUES = 500;

/**
 * A value worth cutting wherever it turns up. Under a secret's name it only has to
 * be no plain word. Under any other, it has to be long and not plainly public:
 * `BASE_URL=http://localhost:3000`, `APP_DIR=/srv/app`, `HOST=docs.example.com`, a name:
 * `MODEL=whisper-large-v3`, `APP_NAME=MyCoolApplication`, a list: `METHODS=GET,POST,PUT`,
 * or words and spaces: `START_CMD="npm run build"`, whose going would blind whatever
 * reads the commands. A generated value gives itself away with a sign none of those
 * has, or twelve letters and digits in a row, both among them.
 *
 * ponytail: a passphrase in words, or generated in short groups (`ABCD1-EFGH2-IJKL3`),
 * under a name nothing knows stays where it is quoted outside the read itself; telling
 * it from a command or a name takes more than its shape.
 */
function worthLearning(name: string | undefined, value: string): boolean {
  if (value.length < MIN_SENSITIVE_VALUE || value.startsWith("$")) return false;
  if (value.includes(REDACTION_MARKER) || PLAIN_WORD.test(value)) return false;
  if (name !== undefined && SENSITIVE_KEY.test(name)) return true;
  if (value.length < MIN_LEARNED_VALUE || /\s/.test(value)) return false;
  if (/^[~.]{0,2}\/[\w./-]*$/.test(value)) return false;
  return !/^[\w.:/,=-]*$/.test(value) || GENERATED.test(value);
}

/**
 * What a dotenv file holds is a secret by where it sits, whatever it looks like
 * and whatever it is called, so the rules cannot be asked to know it: `MAILER_PHRASE`
 * names nothing they know, and the value quoted in a later sentence has no name
 * at all. What a dotenv call read or wrote is searched for values here, and they go
 * from the whole session at the end (`cutLearnedValues`). Only names written the way
 * such files write them count, so that a test run under `--env-file` does not teach
 * its log's `id=…`.
 *
 * ponytail: only what the session showed. A value printed by a script that read
 * the file itself, or typed in a prompt, is known to nothing here; so is one under
 * the floors above, which keep short values from shredding the text.
 */
function learnValues(value: unknown, context: RedactContext): void {
  // A loop and not a call per level: what a dotenv read returned goes whatever it holds,
  // and a result nested deeper than the stack must not take the session with it.
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (Array.isArray(item)) for (const inner of item) pending.push(inner);
    else if (isObject(item)) for (const inner of Object.values(item)) pending.push(inner);
    else if (typeof item === "string") learnText(item, context);
  }
}

function learnText(value: string, context: RedactContext): void {
  // `printf 'A=1\nB=2\n' > .env` holds its lines as written, and `echo K=\"v\" > .env` a quoted value.
  const text = value.replace(/\\n/g, "\n").replace(/\\(["'])/g, "$1");
  const learn = (name: string | undefined, found: string): void => {
    if (context.learned.size < MAX_LEARNED_VALUES && worthLearning(name, found)) context.learned.add(found);
  };
  for (const [, name, written] of text.matchAll(DOTENV_PAIR)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name!) && !SENSITIVE_KEY.test(name!)) continue;
    if (/^["']/.test(written!)) {
      learn(name, written!.slice(1, -1));
      continue;
    }
    // A shell ends a word at an operator the value does not hold: `VALUE=x; echo "K=$VALUE"`,
    // `echo K=x>.env`. A dotenv file may hold one in its value, so the whole goes as well.
    const whole = written!.replace(/;$/, "");
    learn(name, whole);
    const end = whole.search(/[;|&<>)\\]/);
    if (end > 0) learn(name, whole.slice(0, end));
  }
  for (const line of text.split("\n")) {
    const bare = line.trim();
    if (BARE_VALUE.test(bare) && /[A-Za-z]/.test(bare) && /\d/.test(bare)) learn(undefined, bare);
  }
}

/** What says what a record is, not what anybody said: the parse reads these, and they stay. */
const NOT_SAID = new Set([
  ...PATH_KEYS,
  "type",
  "role",
  "uuid",
  "parentUuid",
  "sessionId",
  "id",
  "tool_use_id",
  "name",
  "model",
  "timestamp",
  "version",
  "gitBranch",
]);

type FindValue = (text: string, from: number, walks: Budget) => [at: number, value: string] | undefined;

/**
 * What may be walked along values that then are not there, over a text of some length:
 * one of 100 KB of a letter took a minute over 200 KB of that letter. Past this the text
 * goes whole, since what could not be looked through may hold one.
 *
 * ponytail: a text held up against a value that keeps almost matching, like thousands of
 * zeros against one that starts with dozens, is lost with it. Failure links if a real one is.
 */
const walksOver = (length: number): Budget => ({ left: 4096 + 8 * length });

/** Two bits up per character, so that one falls off the top after `MIN_SENSITIVE_VALUE`, which no value is shorter than. */
const hashedOn = (hash: number, code: number): number => ((hash << 2) ^ code) & 0xffff;

/** What some values still have in common, and how they part after it. */
type Branch = { common: string; value: string | undefined; parts: Map<number, Branch> };

/** Of values in sorted order, so that what the first and the last share, all do. */
function branchOf(values: readonly string[], depth: number): Branch {
  const first = values[0]!;
  const last = values.at(-1)!;
  let end = depth;
  while (end < first.length && first[end] === last[end]) end += 1;
  const groups = new Map<number, string[]>();
  for (const value of values) {
    if (value.length > end) groups.set(value.charCodeAt(end), [...(groups.get(value.charCodeAt(end)) ?? []), value]);
  }
  const parts = new Map<number, Branch>();
  for (const [code, group] of groups) parts.set(code, branchOf(group, end + 1));
  return { common: first.slice(depth, end), value: first.length === end ? first : undefined, parts };
}

/**
 * Finds the next of some values, the longest of those that start together, in one pass
 * over the text whatever their number. A loop over them costs that number times the
 * session's size; one alternation of them is slower than that below a few hundred, and
 * does not compile when they are long.
 */
function valueFinder(values: readonly string[]): FindValue {
  const seen = new Uint8Array(1 << 16);
  for (const value of values) {
    let hash = 0;
    for (let i = 0; i < MIN_SENSITIVE_VALUE; i += 1) hash = hashedOn(hash, value.charCodeAt(i));
    seen[hash] = 1;
  }
  const root = branchOf([...values].sort(), 0);
  return (text, from, walks) => {
    let hash = 0;
    for (let end = from; end < text.length; end += 1) {
      hash = hashedOn(hash, text.charCodeAt(end));
      if (seen[hash] === 0 || end - from < MIN_SENSITIVE_VALUE - 1) continue;
      const at = end - MIN_SENSITIVE_VALUE + 1;
      let found: string | undefined;
      let next = at;
      for (let branch: Branch | undefined = root; branch !== undefined; next += 1) {
        const { common } = branch;
        let same = 0;
        while (same < common.length && text.charCodeAt(next + same) === common.charCodeAt(same)) same += 1;
        next += same;
        if (same < common.length) break;
        found = branch.value ?? found;
        branch = branch.parts.get(text.charCodeAt(next));
      }
      walks.left -= next - at - (found?.length ?? 0);
      if (walks.left < 0) return undefined;
      if (found !== undefined) return [at, found];
    }
    return undefined;
  };
}

/**
 * What a session may cut before a text holding a learned value goes whole, as one too
 * dear to look through does. Each cut makes the text longer and holds a string of its
 * own until the text is done, and finding one spends no walks, so that a value repeated
 * through a few gzipped kilobytes is what the heap has to hold. The most in a real
 * session is 5271.
 *
 * ponytail: one count for a session, so that past it a text with a single hit is lost
 * with the rest. Per-text limits if a real session ever comes near.
 */
const MOST_CUTS = 1_000_000;

function withoutValues(value: unknown, find: FindValue, context: RedactContext, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && NOT_SAID.has(key)) return value;
    let text = "";
    let from = 0;
    const walks = walksOver(value.length);
    for (let hit = find(value, 0, walks); hit !== undefined; hit = find(value, from, walks)) {
      if ((context.counts.dotenv ?? 0) >= MOST_CUTS) {
        count(context, "oversized", 1);
        return marker("oversized");
      }
      text += value.slice(from, hit[0]) + marker("dotenv");
      from = hit[0] + hit[1].length;
      count(context, "dotenv", 1);
    }
    if (walks.left < 0) {
      count(context, "oversized", 1);
      return marker("oversized");
    }
    return text + value.slice(from);
  }
  if (Array.isArray(value)) return value.map((item) => withoutValues(item, find, context));
  if (!isObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) result[entryKey] = withoutValues(entry, find, context, entryKey);
  return result;
}

/**
 * After the whole session, because a value can be quoted long before the read that
 * shows what it is. A line is parsed only if it holds one, and the cut is made on
 * its strings, as one made in the JSON could land across an escape.
 */
function cutLearnedValues(lines: string[], context: RedactContext): string[] {
  if (context.learned.size === 0) return lines;
  // Longest first: a value inside another must not leave the rest of that one.
  const values = [...context.learned].sort((a, b) => b.length - a.length);
  const inText = valueFinder(values);
  const inLine = valueFinder(values.map((value) => JSON.stringify(value).slice(1, -1)));
  return lines.map((line) => {
    const walks = walksOver(line.length);
    if (inLine(line, 0, walks) === undefined && walks.left >= 0) return line;
    try {
      return JSON.stringify(withoutValues(JSON.parse(line), inText, context));
    } catch {
      return withoutValues(line, inText, context) as string;
    }
  });
}

/**
 * How code reaches the environment, which reads like a file called `process.env`.
 *
 * ponytail: the objects it is usually read from. Any other's `.env` in a one-liner
 * costs that one command's result.
 */
const CODE_ENV = /(?:^|\.)(?:process|meta|this|self|globalThis|window|Deno|Bun|ctx|c|os|context|event|req|request)\.env$/;

/** `.env`, `.env.local`, and the other way of naming one: `prod.env`, `.x.env`, `$STAGE.env`. */
function isDotenvPath(filePath: unknown): boolean {
  if (typeof filePath !== "string") return false;
  const name = basename(filePath);
  return name.startsWith(".env") || (/^[\w.*?${}-]*\.env$/.test(name) && !CODE_ENV.test(name));
}

/**
 * Commands that can name a dotenv file without printing any of it. The list runs
 * this way round because the other one has no end: `cut`, `node -e`, `python -c`,
 * `docker exec … cat`, anything behind `ssh` or `timeout`.
 */
const SHELL_NO_READ =
  /^\s*(?:(?:sudo|if|then|elif|else|while|until|do)\s+|[!{(]\s*)*(?:ls|ll|stat|file|wc|test|test-path|\[\[?|echo|printf|touch|chmod|chown|mkdir|rm|mv|cp|ln|cd|git\s+(?:add|rm|mv|status|commit|check-ignore|ls-files))(?:\s|$)/i;

/** Where a shell line, or the code it hands an interpreter, ends one word and starts the next. */
const WORD_BREAK = /[\s"'`(){}=,;|&<>]+/;

/**
 * `cat .env`, `cut -d= -f2 config/.env.local`, `node -e "…readFileSync('.env')…"`,
 * `source .env`: a shell call that names a dotenv file is as much a read of it as
 * `Read {file_path}` is, and what it prints may be any of the file. The command
 * itself stays — it names the file, not what is in it. A revision goes with its
 * word: `git show origin/main:.env`.
 *
 * ponytail: by the name in the command. `node scripts/x.js` opening the file
 * itself, or `load_dotenv()` with no path, still goes up; scrubbing the file's
 * values at upload is the way up.
 */
function readsDotenv(command: unknown): boolean {
  if (typeof command !== "string" || !command.includes(".env")) return false;
  const names = (text: string): boolean => text.split(WORD_BREAK).some((word) => isDotenvPath(word.replace(/^.*:/, "")));
  const text = withoutHeredocs(command);
  // What a substitution or `xargs` turns up goes to whatever takes it: `cat $(ls .env*)`.
  if ((text.match(/\$\([^()]*\)/g) ?? []).some(names) || (/\|\s*xargs\b/.test(text) && names(text))) return true;
  // A backtick or a `$(` left in a segment still runs what it holds.
  return commandSegments(text).some((segment) => (!SHELL_NO_READ.test(segment) || /`|\$\(/.test(segment)) && names(segment));
}

/** Commands that write the file they are given: `tee`, PowerShell's own, `dd of=`, and `cp` from stdin. */
const SHELL_WRITER = /^\s*(?:sudo\s+)?(?:tee|set-content|sc|add-content|ac|out-file|new-item|dd|(?:cp|install)(?=\s.*\/dev\/stdin))(?:\s|$)/i;
/** `tee` behind whatever runs it — `sudo -u app`, `doas`, `ssh host 'tee …'`, `/usr/bin/` — still writes. */
const TEE = /(?:^|[\s/"'])(?:tee|tee-object)(?=\s|$)/i;

/** A word as the shell hands it over: quotes gone, `\ ` a plain space; a Windows `\` stays. */
const unquoted = (word: string): string => word.replace(/\\( )|["'`]/g, "$1");

/** A quoted or escaped word keeps its spaces: `> "My Projects/.env"`. */
const REDIRECT = String.raw`>\s*((?:"[^"]*"|'[^']*'|\\.|[^\s;&|<>"'\\])+)`;
const ANY_REDIRECT = new RegExp(REDIRECT, "g");
/**
 * Quotes go first and run to the end if they never close, so nothing is scanned twice;
 * ahead of them what a backslash escapes, which opens nothing: `echo don\'t > .env`.
 */
const REDIRECT_PAST_QUOTES = new RegExp(String.raw`\\.|'[^']*(?:'|$)|"(?:[^"\\]|\\[\s\S]?)*(?:"|$)|${REDIRECT}`, "g");
/**
 * Commands whose quoted arguments are only text: `git commit -m "x > .env"` writes
 * nothing. What runs its argument is not here, as `sh -c`, `ssh` and `sudo` hold a
 * real write in those quotes.
 */
const TEXT_ARGUMENTS = /^\s*(?:echo|printf|grep|egrep|fgrep|rg|git\s+(?:commit|tag|log|grep)|gh)(?:\s|$)/i;

/** `git commit -m "$(cat <<'EOF'`: what such a heredoc holds is a message. */
const TAKES_MESSAGE = /^\s*(?:git\s+(?:commit|tag)|gh)\s/;

/** A path as a call's first argument, in quotes a shell may have had to escape. */
const PATH_ARGUMENT = String.raw`\(\s{0,8}\\?["'\`]([^"'\`\\\n]{1,256})\\?["'\`]`;
/**
 * What a one-liner calls to write a file it names: `fs.writeFileSync('.env', …)`,
 * `Path('.env').write_text(…)`, and `open('.env', 'w')`, as `open` alone only reads.
 *
 * ponytail: a literal path, in the usual calls. A path in the script's own variable,
 * or a call not listed, leaves the one-liner as it was; parsing each language is the
 * way up.
 */
const WRITE_CALL = new RegExp(
  String.raw`\b(?:(?:write|append)File(?:Sync)?|createWriteStream|file_put_contents|(?:File|IO)\.write)${PATH_ARGUMENT}` +
    String.raw`|\bf?open${PATH_ARGUMENT}\s{0,8},\s{0,8}(?:mode\s{0,8}=\s{0,8})?\\?["'][a-z]{0,2}[wax+]` +
    String.raw`|\bPath${PATH_ARGUMENT}\s{0,8}\)\.write_`,
  "g",
);

/** The dotenv file a statement redirects, tees or opens to write, if it writes one. */
function dotenvTarget(statement: string): string | undefined {
  // `>|` overrides `noclobber` and is no pipe.
  for (const segment of commandSegments(statement.replace(/>\|/g, ">"))) {
    const text = TEXT_ARGUMENTS.test(segment);
    for (const redirect of segment.matchAll(text ? REDIRECT_PAST_QUOTES : ANY_REDIRECT)) {
      if (redirect[1] !== undefined && isDotenvPath(unquoted(redirect[1]))) return unquoted(redirect[1]);
    }
    if (text) continue;
    for (const call of segment.matchAll(WRITE_CALL)) {
      const path = call[1] ?? call[2] ?? call[3];
      if (isDotenvPath(path)) return path;
    }
    const writer = SHELL_WRITER.exec(segment) ?? TEE.exec(segment);
    if (!writer) continue;
    const after = segment.slice(writer.index + writer[0].length);
    const named = after.trim().split(/\s+/).map((word) => unquoted(word).replace(/^of=/, "")).find(isDotenvPath);
    if (named) return named;
  }
  return undefined;
}

/**
 * A line cut where `&&`, `||` or `;` end a statement outside quotes, the
 * separators kept, and whether a quote is still open where the line ends.
 */
function statements(line: string): { parts: string[]; open: boolean } {
  const parts: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === "\\" && quote !== "'") {
      i += 1;
    } else if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === ";" || ((char === "&" || char === "|") && line[i + 1] === char)) {
      const width = char === ";" ? 1 : 2;
      parts.push(line.slice(start, i), line.slice(i, i + width));
      start = i + width;
      i += width - 1;
    }
  }
  parts.push(line.slice(start));
  return { parts, open: quote !== undefined };
}

/** `VALUE=x`, then `echo "K=$VALUE" > .env`: the value sits where the write only names it. */
function expandsAssigned(statement: string, assigned: ReadonlySet<string>): boolean {
  for (const match of statement.matchAll(/\$\{?([A-Za-z_]\w*)/g)) if (assigned.has(match[1]!)) return true;
  return false;
}

/** A write that closes a group or a substitution: `{ …; } > .env`, `(…) | tee .env`, `done > .env`. */
const GROUP_WRITE = /(?:[})]|\b(?:done|fi|esac))\s*(?:\d?>|&>|\|)/;
/** A write whose values come later or from around it: `exec 3>.env; echo K=v >&3`, `export K=v; envsubst < t > .env`. */
const WRITES_FROM_AROUND = /^\s*exec\b|\benvsubst\b/;

/**
 * `F=.env`, and a loop over a list: both say what `$F` is, and that `F` was set. A quote
 * right behind the `=` makes the value one word, one anywhere else closes something.
 */
const ASSIGNMENT = /(?<![\w$])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g;
const FOR_LOOP = /\bfor\s+([A-Za-z_]\w*)\s+in\s([^\n;]{0,2000})/g;
const VARIABLE = /\$\{?([A-Za-z_]\w*)\}?/g;
/** `${F:-.env}`, `${F:=.env}`: nothing else in the command says what `F` is. */
const VARIABLE_DEFAULT = /\$\{\w+:?[-=]([^{}]*)\}/g;
/** What says only where a path starts or how it is named: `$HOME/.env`, `$STAGE.env`. */
const VARIABLE_DIR = /\$\{?\w+\}?(?:\/|(?=\.env\b))/g;
/** `F="$(pwd)/.env"`: what a substitution turns up says as little. */
const SUBSTITUTED_DIR = /\$\([^()]*\)\/?/g;

/** What sed's `a`, `i` and `c` open with, right against the text: `$aK=v`, `1iK=v`, `/^K=/cK=v`. */
const SED_TEXT_COMMAND = /(?<=^|['"\s])(?:\$|\d{1,12}|\/[^/\n]{0,256}\/)[ \t]{0,8}[aic]\\?[ \t]{0,8}/g;

/**
 * An in-place editor wherever a statement runs it: behind `time`, `/usr/bin/`,
 * `docker exec app`, in the quotes of `ssh host "…"`. Only where to read from, as the
 * parse says whether it edits and what.
 *
 * ponytail: up to 16 flags ahead of its script, as any run of them is tried again from each
 * word in it, and the usual editors. `time sed 's/a/b/' -i .env` or `sh -c "ex .env"` keeps
 * its script, as a command nothing recognises does.
 */
const EDITOR_CALL = /(?<![\w.-])(?:g?sed|g?awk|perl|ruby)(?:\s+-\S+){0,16}?\s+(?:-[a-zA-Z0-9]*[iI]|--in-place|--include)/;
/** What hands an editor its files from in front of it: `find … -exec sed -i`, `… | xargs sed -i`. */
const FEEDS_FILES = /\s-(?:exec|ok)(?:dir)?\s|\bxargs\s/;

/**
 * The text of an edit's script: `s|a|b|` and `s#a#b#` split where `s/a/b/` does, and
 * `sub("a","b")`, whose values have no name to go by, at its quotes.
 */
function learnEdit(statement: string, context: RedactContext): void {
  const script = statement.replace(SED_TEXT_COMMAND, "\n");
  const lines = script.replaceAll(/(?<![\w-])s([^\w\s\\])/.exec(script)?.[1] ?? "/", "\n");
  learnValues(lines, context);
  learnValues(lines.replace(/["']/g, "\n"), context);
}

/**
 * What a session's commands naming a dotenv file may come to, past which one goes
 * whole. Each statement of them is held up to a dozen patterns, several times what a
 * byte of any other text costs, on the thread that serves requests. The most in a real
 * session is 3.1 MB, out of 552 MB, and in any other 67 KB.
 *
 * ponytail: what goes whole reads as no write to the parse, and teaches nothing of what
 * it held. Raise it if sessions come near, or take redaction off that thread.
 */
const DOTENV_COMMAND_CHARS = 4 * 1024 * 1024;

/**
 * `cat > .env << 'EOF'`, `echo "KEY=…" >> .env.local`, `… | tee .env`: a shell
 * call that writes a dotenv file holds what it writes, so unlike a read the
 * command is cut too. Only what carries the values goes — the statement that
 * writes, with the heredoc it feeds, and a heredoc body that names the file
 * itself (`python - <<PY` opening `.env`) — and the statement keeps its target,
 * so `sed -i` beside it is still an edit and the parse still sees a write.
 */
function cutDotenvWrites(command: string, context: RedactContext): string {
  if (!command.includes(".env")) return command;
  if (!spend(context.dotenvCommands, command.length)) {
    count(context, "oversized", 1);
    return marker("oversized");
  }
  // Once, as a statement asking for itself would rescan the command for each one.
  const assigned = new Set<string>();
  const files = new Map<string, string>();
  // ponytail: one budget for the command, as a long name used in every statement otherwise
  // grows it past what memory holds. A write past the budget reads as no write, as one
  // through a variable nothing knows does; a real command spends a few hundred bytes of it.
  let room = 1 << 16;
  const resolved = (text: string): string =>
    text.replace(VARIABLE_DEFAULT, "$1").replace(VARIABLE, (whole, name: string) => {
      const file = files.get(name);
      if (file === undefined || file.length > room) return whole;
      room -= file.length;
      return file;
    });
  // ponytail: a substitution inside one, the deepest a path is usually built.
  const unsubstituted = command.replace(SUBSTITUTED_DIR, "").replace(SUBSTITUTED_DIR, "");
  // In the order they run, for `A=.env; B=$A`.
  for (const [, name, list] of [...unsubstituted.matchAll(ASSIGNMENT), ...command.matchAll(FOR_LOOP)]) {
    assigned.add(name!);
    const file = resolved(list!).split(/\s+/).map(unquoted).find(isDotenvPath);
    // A glob in the list is that file as far as a write goes.
    if (file !== undefined) files.set(name!, file.replace(/[*?]/g, ""));
  }
  const parsedEdit = (text: string): string | undefined =>
    shellEditWords(resolved(text).replace(VARIABLE_DIR, "").replace(/\\\n/g, " ")).find(isDotenvPath);
  const editedFile = (text: string): string | undefined => {
    const call = EDITOR_CALL.exec(text);
    const before = text.slice(0, call?.index ?? 0);
    // `git commit -m "sed -i …"` only speaks of one.
    if (call === null || TEXT_ARGUMENTS.test(before.slice(before.lastIndexOf("|") + 1))) return parsedEdit(text);
    return parsedEdit(text.slice(call.index)) ?? (FEEDS_FILES.test(before) ? resolved(before).split(WORD_BREAK).find(isDotenvPath) : undefined);
  };
  const lines = command.split("\n");
  const kept: string[] = [];
  let written: string | undefined;
  let spread = false;
  for (let i = 0; i < lines.length; i += 1) {
    let writes = false;
    // A backslash joins them, to the shell and so here.
    const first = i;
    while (lines[i]!.endsWith("\\") && i + 1 < lines.length) i += 1;
    const line = lines.slice(first, i + 1).join("\n");
    const { parts, open } = statements(line);
    // A line that goes on in the next (a trailing pipe, an open quote) is one
    // statement with it, and the values may sit on either.
    if (open || /[\\|]\s*$/.test(line)) spread = true;
    kept.push(
      parts
        .map((part) => {
          // Once per statement of what can be a few hundred thousand, so no check for one that names no file.
          if (!part.includes(".env") && (files.size === 0 || !part.includes("$"))) return part;
          const indent = /^\s*/.exec(part)![0];
          const target = dotenvTarget(resolved(part));
          if (target === undefined) {
            // The script holds the value, and the parse needs only to see an edit.
            const edited = editedFile(part);
            if (edited === undefined) return part;
            writes = true;
            learnEdit(part, context);
            const edit = `sed -i ${marker("dotenv")} ${edited}`;
            if (expandsAssigned(part, assigned)) {
              spread = true;
              written ??= edit;
            }
            return `${indent}${edit}${part.slice(part.trimEnd().length)}`;
          }
          const write = `${marker("dotenv")} > ${target}`;
          writes = true;
          written ??= write;
          learnValues(part, context);
          if (GROUP_WRITE.test(part) || WRITES_FROM_AROUND.test(part) || expandsAssigned(part, assigned)) spread = true;
          return `${indent}${write}`;
        })
        .join(""),
    );
    const terminator = HEREDOC.exec(line)?.[2];
    if (terminator === undefined) continue;
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== terminator) end += 1;
    const body = lines.slice(i + 1, end);
    if (writes) {
      learnValues(body.join("\n"), context);
      if (expandsAssigned(body.join("\n"), assigned)) spread = true;
      i = end;
      continue;
    }
    const message = commandSegments(parts.find((part) => HEREDOC.test(part))!).every((segment) => TAKES_MESSAGE.test(segment));
    // A shell or an interpreter fed a script that writes the file: what the script
    // holds is written as surely as what `cat > .env` is fed.
    let bodyWrites: string | undefined;
    for (const line of message ? [] : body) {
      const edited = editedFile(line);
      if (edited !== undefined) learnEdit(line, context);
      bodyWrites ??= dotenvTarget(resolved(line)) ?? edited;
    }
    if (bodyWrites !== undefined) {
      learnValues(body.join("\n"), context);
      if (expandsAssigned(body.join("\n"), assigned)) {
        spread = true;
        written ??= `${marker("dotenv")} > ${bodyWrites}`;
      }
    }
    // A body is code as often as not, where `cfg.env` is a property and not a file.
    const namesDotenv =
      bodyWrites !== undefined || (!message && body.some((line) => line.split(WORD_BREAK).some((word) => basename(word).startsWith(".env"))));
    // One at a time: spread, a body of a few hundred thousand lines overflows the stack.
    for (const line of namesDotenv ? [marker("dotenv")] : body) kept.push(line);
    if (end < lines.length) kept.push(lines[end]!);
    i = end;
  }
  // A quoted script over several lines is an edit that no one of them shows.
  const editAcross = written === undefined && spread ? parsedEdit(command) : undefined;
  if (editAcross !== undefined) {
    learnEdit(command, context);
    written = `sed -i ${marker("dotenv")} ${editAcross}`;
  }
  // A group or a quoted string over several lines holds the values outside the
  // statement that names the file (`{ echo A=1; echo B=2; } > .env`), so the
  // whole command goes, and only the write is left for the parse to see.
  if (written !== undefined && spread) {
    learnValues(command, context);
    return written;
  }
  return kept.join("\n");
}

/** A multi-edit keeps its steps: each is one edit to the parse, and only their strings go. */
function cutDotenvInput(input: Record<string, unknown>, context: RedactContext): void {
  for (const field of EDIT_INPUT_FIELDS) {
    if (typeof input[field] === "string") {
      learnValues(input[field], context);
      input[field] = marker("dotenv");
      count(context, "dotenv", 1);
    }
  }
  if (!Array.isArray(input.edits)) return;
  for (const edit of input.edits) if (isObject(edit)) cutDotenvInput(edit, context);
}

const FILE_ARGUMENT = /^(?:file_?path|filePath|notebook_path|(?:relative_)?path|paths|file|files|filename|target_file)$/;

/**
 * Whether a call that is no shell works on a dotenv file, by the argument that
 * says what it works on: `Read {file_path}`, `Grep {path}`, a filesystem
 * server's `read_file {path}`. A glob reads a gitignored file as well as a named
 * one, however it is spelled (`{.env,.env.local}`, `*.env`), so any mention
 * counts, and the worst of that is one search's result on `*.envelope.ts`. Code
 * a tool runs (`REPL {code}`, `exec {script}`) is read as a shell line is.
 *
 * ponytail: by what the call names. A search that names no file (`Grep
 * {pattern}`, `grep -r KEY .`) still goes up when `.env` is not ignored; reading
 * its result's lines for a dotenv path is the way up.
 */
function callNamesDotenv(name: unknown, input: Record<string, unknown>): boolean {
  if (typeof input.glob === "string" && input.glob.includes(".env")) return true;
  // A workflow's script hands out prompts: it reads nothing by itself.
  if (readsDotenv(input.code) || readsDotenv(input.cmd) || (name !== "Workflow" && readsDotenv(input.script))) return true;
  return Object.entries(input).some(([key, value]) => FILE_ARGUMENT.test(key) && [value].flat().some(isDotenvPath));
}

/**
 * `! cat .env` typed in Claude Code is no tool call: the command comes as one
 * user turn, `<bash-input>…</bash-input>`, and what it printed as the next,
 * `<bash-stdout>…`. The cuts of a shell call apply across the pair.
 */
function scanBashMode(message: Record<string, unknown>, content: string, context: RedactContext): void {
  const input = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(content)?.[1];
  if (input !== undefined) {
    const cut = cutDotenvWrites(input, context);
    context.bashInputTouchedDotenv = cut !== input || readsDotenv(input);
    if (cut !== input) {
      message.content = `<bash-input>${cut}</bash-input>`;
      count(context, "dotenv", 1);
    }
    return;
  }
  if (!context.bashInputTouchedDotenv || !content.trimStart().startsWith("<bash-stdout>")) return;
  context.bashInputTouchedDotenv = false;
  learnValues(content.replace(/<\/?bash-std(?:out|err)>/g, "\n"), context);
  message.content = marker("dotenv");
  count(context, "dotenv", 1);
}

/** Where a background command's output also lands: `tail -f …/tasks/<id>.output`, `Read {file_path}`. */
const TASK_OUTPUT = /(?<![\w-])([\w-]+)\.output\b/g;

/** Whether a call goes on with a cut background command, by stopping it or reading what it printed. */
function followsCutTask(input: Record<string, unknown>, context: RedactContext): boolean {
  const tasks = [input.task_id, input.shell_id, input.bash_id];
  for (const text of [input.file_path, input.command]) {
    if (typeof text === "string") tasks.push(...[...text.matchAll(TASK_OUTPUT)].map((match) => match[1]));
  }
  return tasks.some((task) => typeof task === "string" && context.envToolUseIds.has(task));
}

function scanDotenv(record: Record<string, unknown>, context: RedactContext): void {
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (isObject(message) && typeof content === "string") return scanBashMode(message, content, context);
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isObject(block)) continue;

    if (block.type === "tool_use") {
      const input = isObject(block.input) ? block.input : undefined;
      if (!input) continue;
      const command = input.command;
      const cut = typeof command === "string" ? cutDotenvWrites(command, context) : command;
      if (cut !== command) {
        input.command = cut;
        count(context, "dotenv", 1);
      }
      const named = callNamesDotenv(block.name, input);
      if (named) cutDotenvInput(input, context);
      if ((named || cut !== command || readsDotenv(command) || followsCutTask(input, context)) && typeof block.id === "string") {
        context.envToolUseIds.add(block.id);
      }
    }

    if (block.type === "tool_result") {
      const id = block.tool_use_id;
      if (typeof id !== "string" || !context.envToolUseIds.has(id)) continue;
      // A command sent to the background goes on as a task: stopping that repeats
      // the command, and reading it prints what the command printed.
      const task = isObject(record.toolUseResult) ? record.toolUseResult.backgroundTaskId : undefined;
      if (typeof task === "string") context.envToolUseIds.add(task);
      learnValues(block.content, context);
      // A tool can say "done" in its text and return the file as data.
      learnValues(record.mcpMeta, context);
      block.content = marker("dotenv");
      count(context, "dotenv", 1);
      if (record.toolUseResult !== undefined) {
        learnValues(record.toolUseResult, context);
        record.toolUseResult = marker("dotenv");
        count(context, "dotenv", 1);
      }
    }
  }
}

/**
 * Codex and Kimi pass a tool the name the agent typed, relative to where the
 * session stood. Read from a root above that it would be another file, so it is
 * made whole here and masking spells it from the root like any other.
 */
function fromBase(value: string, base: string | undefined): string {
  if (base === undefined || value.length === 0) return value;
  if (looksAbsolute(value) || value.startsWith("~") || value.includes("://")) return value;
  return resolve(base, value);
}

/**
 * What redaction may add to a session, in characters, net of what it takes off. A marker
 * is longer than a short value, so `7z -pa ` comes to four times its length, and an upload
 * of 400 KB outgrew the heap, on the cut itself as well as on all it kept.
 *
 * ponytail: one count for a session, so past it any text with a hit goes whole, however
 * little it holds. A limit per text if a real session ever comes near.
 */
const ADDED_CHARS = 16 * 1024 * 1024;
/** One, as millions of short texts past the limit would each pay for a stack trace. */
const ADDS_TOO_MUCH = new RangeError("adds more than is left");

/**
 * The rules, then the paths. A pattern that runs out of backtrack stack on a run of
 * millions of characters reports it as a RangeError, and then nothing says how much of
 * the text is a secret: all of it goes, as the session around it can still go out. The
 * same goes for a text that would take the session past `ADDED_CHARS`.
 */
function scrubbed(text: string, context: RedactContext, key?: string): string {
  try {
    const secretsGone = applyRules(text, context.rules, (type, amount) => {
      count(context, type, amount);
      // Ahead of the cut, whose result is what the heap runs out on. A match adds at most its marker.
      if (amount * marker(type).length > context.added.left) throw ADDS_TOO_MUCH;
    });
    // Paths last: a secret already replaced by its marker must not then be read
    // as a directory, and `[ISY_REDACTED:…]` carries no slash to be read as one.
    const onMask = (amount: number): void => count(context, "path", amount);
    const clean = key && PATH_KEYS.has(key)
      ? maskPath(fromBase(secretsGone, context.base), context.roots, onMask)
      : maskPaths(secretsGone, context.roots, onMask);
    if (spend(context.added, clean.length - text.length)) return clean;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  count(context, "oversized", 1);
  return marker("oversized");
}

function redactValue(value: unknown, context: RedactContext, key?: string): unknown {
  if (typeof value === "string") {
    if (key && value.length >= MIN_SENSITIVE_VALUE && (SENSITIVE_KEY.test(key) || (KEY_FIELD.test(key) && GENERATED.test(value)))) {
      if (value.startsWith(`[${REDACTION_MARKER}`)) return value;
      count(context, "assignment", 1);
      return marker("assignment");
    }
    return scrubbed(value, context, key);
  }

  if (Array.isArray(value)) return value.map((item) => redactValue(item, context));

  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      // A key holds a path too — Claude Code keys its per-file state by
      // absolute path — and `maskDeep` masks keys for the same reason. Only
      // the path rules run on it: a secret is a value, never a field name.
      const masked = maskPath(entryKey, context.roots, (amount) => count(context, "path", amount));
      result[masked] = redactValue(entryValue, context, entryKey);
    }
    return result;
  }

  return value;
}

/** The working directory this transcript recorded, before anything is rewritten. */
function learnRoot(record: Record<string, unknown>, context: RedactContext): void {
  if (context.rootGiven || context.roots.cwd) return;
  const cwd = rootOf(record);
  if (!cwd) return;
  context.roots = { ...context.roots, ...resolveRoots({ cwd }) };
}

/**
 * Claude Code's `attachment` records are the harness's context for the model:
 * the account's email (`session_context`), its organisation (`credential_org`),
 * the whole system prompt with memory and CLAUDE.md (`prompt_snapshot`), the
 * connectors' instructions. Nothing downstream reads past their `type`, so that
 * is all that goes. The record itself stays: the next record names it as its
 * `parentUuid`, and the parser walks that chain.
 *
 * Claude Code 2.1.30x also records the request it sends: `api-request-shape`
 * carries the system prompt and the tool definitions, `api-request-blob` the
 * context blocks sent beside the conversation — memory, CLAUDE.md, the email
 * again — and `api-request` the parameters, whose `safeguards` hand a
 * classifier the account's user name, home directory and permission rules.
 * `bridge-session` and `artifact-autoreact-ledger` are cut the same way: one
 * names the account and organisation that own the session's bridge, the other
 * the account. The parser reads none of them past their type, so only the
 * fields that name them go — and the ones that say a subagent made the request
 * (`subagents.ts:asSidechain`), or it is counted as the session's own.
 */
const REQUEST_RECORD_KEYS = new Set([
  "type",
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "version",
  "shapeHash",
  "hash",
  "isSidechain",
  "parentToolUseID",
  "agentId",
]);
const STRIPPED_RECORD_TYPES = new Set([
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "bridge-session",
  "artifact-autoreact-ledger",
]);

function stripAttachment(record: Record<string, unknown>, context: RedactContext): void {
  if (typeof record.type === "string" && STRIPPED_RECORD_TYPES.has(record.type)) {
    for (const key of Object.keys(record)) if (!REQUEST_RECORD_KEYS.has(key)) delete record[key];
    count(context, "attachment", 1);
    return;
  }
  if (record.type !== "attachment") return;
  const kind = isObject(record.attachment) ? record.attachment.type : undefined;
  record.attachment = typeof kind === "string" ? { type: kind } : {};
  delete record.rendered;
  delete record.renderedRole;
  count(context, "attachment", 1);
}

/**
 * Harness bookkeeping Claude Code writes beside a turn, read by nothing here or
 * on the server. `wireToolInputs` repeats every call's input, out of reach of
 * the dotenv cut, which edits the copy in `message` (`scanDotenv`);
 * `serverClassifierRequest` and `serverClassifierContext` are what a permission
 * classifier was shown, the working tree's git state included;
 * `wireIngestContext` and `permissionDecision` say where a call ran and what
 * allowed it; `mcpMeta` repeats what an MCP tool returned, as out of reach of the
 * cut as `wireToolInputs` is.
 */
const HARNESS_FIELDS = [
  "wireToolInputs",
  "serverClassifierRequest",
  "serverClassifierContext",
  "wireIngestContext",
  "permissionDecision",
  "mcpMeta",
];

function stripHarnessFields(record: Record<string, unknown>, context: RedactContext): void {
  let stripped = false;
  for (const field of HARNESS_FIELDS) {
    if (!(field in record)) continue;
    delete record[field];
    stripped = true;
  }
  if (stripped) count(context, "attachment", 1);
}

/**
 * A user record marked `isMeta` is the harness talking in the user's place: a
 * skill's body, a `<system-reminder>`, a command's caveat, an extension's
 * instructions, a peer agent's message. Read as text it is a turn the
 * developer never typed, holding files the developer never sent, so only a
 * marker goes. None carries a tool result, and the record stays where it is:
 * the next one names it as its `parentUuid`.
 */
function stripMeta(record: Record<string, unknown>, context: RedactContext): void {
  if (record.type !== "user" || record.isMeta !== true || !isObject(record.message)) return;
  record.message = { ...record.message, content: marker("meta") };
  count(context, "attachment", 1);
}

function redactRecord(
  record: Record<string, unknown>,
  context: RedactContext,
): Record<string, unknown> {
  learnRoot(record, context);
  scanDotenv(record, context);
  stripAttachment(record, context);
  stripHarnessFields(record, context);
  stripMeta(record, context);
  return redactValue(record, context) as Record<string, unknown>;
}

export interface RedactOptions extends MaskRoots {
  extraPatterns?: readonly string[];
  /** Where the session stood, when that is below `cwd`: `git.ts:maskRootsFor`. */
  base?: string;
}

function createContext(options: RedactOptions, invalid: string[]): RedactContext {
  return {
    rules: [...BUILTIN_RULES, ...compileExtraRules(options.extraPatterns, invalid)],
    counts: {},
    envToolUseIds: new Set(),
    bashInputTouchedDotenv: false,
    learned: new Set(),
    structures: { left: STRUCTURES },
    dotenvCommands: { left: DOTENV_COMMAND_CHARS },
    added: { left: ADDED_CHARS },
    // The home directory is this machine's and is never in the transcript's
    // gift, so it is read here rather than passed by every caller.
    roots: resolveRoots({ cwd: options.cwd, home: options.home ?? homedir() }),
    rootGiven: Boolean(options.cwd),
    base: options.base,
  };
}

function summarize(
  context: RedactContext,
  lines: number,
  unparsedLines: number,
  invalidExtraPatterns: string[],
): RedactionSummary {
  const replacements = Object.values(context.counts).reduce((total, value) => total + value, 0);
  return { counts: context.counts, replacements, lines, unparsedLines, invalidExtraPatterns };
}

function redactOneLine(line: string, context: RedactContext): { line: string; unparsed: boolean } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { line: trimmed, unparsed: false };

  // Parsing and copying it would hold twice what the parser allows itself to keep.
  if (!mayParse(trimmed, context.structures)) {
    count(context, "oversized", 1);
    return { line: marker("oversized"), unparsed: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { line: scrubbed(trimmed, context), unparsed: true };
  }

  if (!isObject(parsed)) {
    return {
      line: JSON.stringify(redactValue(parsed, context)),
      unparsed: true,
    };
  }

  return { line: JSON.stringify(redactRecord(parsed, context)), unparsed: false };
}

function chargedLine(line: string, context: RedactContext): { line: string; unparsed: boolean } {
  const left = context.added.left;
  const result = redactOneLine(line, context);
  // What its texts did not pay for: a cut by key name, and a marker past the limit, which
  // is more than a text shorter than it, so that a line of such texts still grew threefold.
  if (spend(context.added, result.line.length - line.length - (left - context.added.left))) return result;
  count(context, "oversized", 1);
  return { line: marker("oversized"), unparsed: true };
}

/**
 * A transcript's lines, redacted. With no `cwd`, paths are rooted at the first
 * record that names one; with no `home`, at the home that directory implies,
 * else this machine's. Exported as `isy/redact` so the server can re-run the
 * rules over a transcript an older client uploaded: there the machine is the
 * server, so it passes `home: ""` and roots paths in the transcript alone.
 */
export function redactLines(
  lines: Iterable<string>,
  options: RedactOptions = {},
): { lines: string[]; summary: RedactionSummary } {
  const invalid: string[] = [];
  const context = createContext(options, invalid);
  const output: string[] = [];
  let total = 0;
  let unparsed = 0;

  for (const line of lines) {
    total += 1;
    const result = chargedLine(line, context);
    if (result.line.length === 0) continue;
    if (result.unparsed) unparsed += 1;
    output.push(result.line);
  }

  const clean = cutLearnedValues(output, context);
  return { lines: clean, summary: summarize(context, total, unparsed, invalid) };
}

/**
 * `redactLines` for lines that arrive one at a time — a file read as it streams,
 * or a Claude session with its subagents spliced in (`subagents.ts`). One
 * context for the whole stream, so the working directory the first record names
 * roots every path after it, the subagents' included.
 */
export async function redactLineStream(
  lines: AsyncIterable<string>,
  options: RedactOptions = {},
): Promise<{ lines: string[]; summary: RedactionSummary }> {
  const invalid: string[] = [];
  const context = createContext(options, invalid);
  const output: string[] = [];
  let total = 0;
  let unparsed = 0;

  for await (const line of lines) {
    total += 1;
    const result = chargedLine(line, context);
    if (result.line.length === 0) continue;
    if (result.unparsed) unparsed += 1;
    output.push(result.line);
  }

  const clean = cutLearnedValues(output, context);
  return { lines: clean, summary: summarize(context, total, unparsed, invalid) };
}

export function redactTranscriptFile(
  filePath: string,
  options: RedactOptions = {},
): Promise<{ lines: string[]; summary: RedactionSummary }> {
  return redactLineStream(fileLines(filePath), options);
}
