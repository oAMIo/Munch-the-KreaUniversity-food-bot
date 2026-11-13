/**
 * plato-menu: schedule a new mess menu.
 *
 *   plato-menu <menu.pdf|.txt|.yaml> <go-live date>   read, check, confirm, schedule
 *   plato-menu list                                   all menus and which one is live
 *   plato-menu show [date]                            print a menu (default: live one)
 *   plato-menu remove <date>                          drop a menu that hasn't gone live
 *
 * A PDF or text file is turned into the menu structure by DeepSeek, then
 * strictly validated (every week, day and meal present) and shown in full
 * for you to check before anything is saved. The file is saved as
 * MENUS_DIR/<date>.yaml; the bot picks it up on that date with no restart.
 * The week containing the go-live date is week 1 of the new menu's cycle.
 */

import { execFileSync } from "child_process";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { createInterface } from "readline";
import dotenv from "dotenv";
import * as yaml from "js-yaml";
import OpenAI from "openai";
import { DAYS, MEALS, WEEK_TYPES, listMenuFiles, loadMenu, MenuError } from "../menu";
import type { MenuData } from "../menu";
import { localTodayIso } from "../time";

const TIMEZONE = "Asia/Kolkata";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEK_LABEL: Record<string, string> = { odd_week: "Week 1", even_week: "Week 2" };

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function menusDir(): string {
  const dir = (process.env.MENUS_DIR ?? "").trim();
  if (!dir) fail("MENUS_DIR is not set (expected in /etc/plato/env).");
  return dir;
}

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Accepts 2026-11-20, 20 Nov, 20 November 2026, 20/11, 20/11/2026, today, tomorrow. */
export function parseDate(input: string, todayIso: string): string | null {
  const s = input.trim().toLowerCase();
  const [ty, tm, td] = todayIso.split("-").map(Number);
  if (s === "today") return todayIso;
  if (s === "tomorrow") return new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  // Without a year: this year, or next year if that date has already passed.
  const withYear = (d: number, mo: number, y?: number): string | null => {
    if (y !== undefined) return iso(y < 100 ? 2000 + y : y, mo, d);
    const thisYear = iso(ty, mo, d);
    return thisYear && thisYear < todayIso ? iso(ty + 1, mo, d) : thisYear;
  };
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(s);
  if (m) return withYear(+m[1], +m[2], m[3] ? +m[3] : undefined);
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?,?(?:\s+(\d{4}))?$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    if (mo > 0) return withYear(+m[1], mo, m[3] ? +m[3] : undefined);
  }
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?$/.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    if (mo > 0) return withYear(+m[2], mo, m[3] ? +m[3] : undefined);
  }
  return null;
}

function prettyDate(dateIso: string): string {
  const d = new Date(dateIso + "T00:00:00Z");
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function readMenuText(file: string): string {
  if (extname(file).toLowerCase() === ".pdf") {
    let text: string;
    try {
      text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
    } catch (err) {
      fail(`couldn't read the PDF: ${(err as Error).message}`);
    }
    if (text.replace(/\s/g, "").length < 200) {
      fail("this PDF has almost no text in it (probably a scan or photo). Ask Claude to type it up, or export it as text.");
    }
    return text;
  }
  return readFileSync(file, "utf-8");
}

async function extractWithLLM(text: string): Promise<MenuData> {
  const apiKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (!apiKey) fail("DEEPSEEK_API_KEY is not set (expected in /etc/plato/env).");
  const system =
    "You convert a university mess menu into JSON. Output ONLY a JSON object of this shape:\n" +
    '{"weeks": [ {"monday": {"breakfast": [..], "lunch": [..], "snack": [..], "dinner": [..]}, "tuesday": {..}, ... "sunday": {..}} ]}\n' +
    "Rules:\n" +
    "- One entry in weeks per distinct weekly menu, in order (Week 1 first). Usually 2 weeks; if the menu is the same every week, give 1.\n" +
    "- All seven days, all four meals. 'snack' is the evening snacks / high tea. If a meal truly isn't served, use [].\n" +
    "- Each dish is one string, copied exactly as written (spelling, capitals, quantities like '(2 Pcs)'). " +
    "Never merge, invent, translate or drop dishes.\n" +
    "- Skip notes and footers that aren't dishes (e.g. 'bread basket served daily').";
  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com", maxRetries: 1, timeout: 180_000 });
  process.stdout.write("Reading the menu with DeepSeek (takes up to a minute)… ");
  const resp = await client.chat.completions.create({
    model: "deepseek-chat",
    temperature: 0,
    max_tokens: 8000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
  });
  console.log("done.");
  let parsed: { weeks?: unknown };
  try {
    parsed = JSON.parse(resp.choices[0]?.message?.content ?? "");
  } catch {
    fail("DeepSeek didn't return readable JSON. Try again, or ask Claude to convert this menu.");
  }
  const weeks = parsed.weeks;
  if (!Array.isArray(weeks) || weeks.length < 1 || weeks.length > 2) {
    fail(`expected 1 or 2 weekly menus, got ${Array.isArray(weeks) ? weeks.length : "none"}.`);
  }
  return { odd_week: weeks[0], even_week: weeks[1] ?? weeks[0] } as MenuData;
}

function toYaml(menu: MenuData, header: string): string {
  // Same compact shape as the hand-written menu.yaml: one meal per line.
  const lines = [header, ""];
  for (const week of ["odd_week", "even_week"] as const) {
    lines.push(`${week}:`);
    for (const day of DAYS) {
      lines.push(`  ${day}:`);
      for (const meal of MEALS) {
        const flow = yaml.dump(menu[week][day][meal], { flowLevel: 0, lineWidth: -1 }).trim();
        lines.push(`    ${meal}: ${flow}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function printMenu(menu: MenuData): void {
  const sameWeeks = JSON.stringify(menu.odd_week) === JSON.stringify(menu.even_week);
  for (const week of sameWeeks ? (["odd_week"] as const) : WEEK_TYPES.slice().reverse()) {
    console.log(`\n━━ ${sameWeeks ? "Every week" : WEEK_LABEL[week]} ━━`);
    for (const day of DAYS) {
      console.log(`\n${day[0].toUpperCase()}${day.slice(1)}`);
      for (const meal of MEALS) {
        const dishes = menu[week][day][meal];
        console.log(`  ${meal.padEnd(9)} ${dishes.length ? dishes.join(", ") : "(none)"}`);
      }
    }
  }
  console.log("");
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    }),
  );
}

function statusOf(startIso: string, files: { startIso: string }[], todayIso: string): string {
  const live = files.filter((f) => f.startIso <= todayIso).pop();
  if (live?.startIso === startIso) return "LIVE now";
  return startIso > todayIso ? "scheduled" : "finished";
}

async function cmdAdd(file: string, dateArg: string, yes: boolean): Promise<void> {
  const todayIso = localTodayIso(TIMEZONE);
  const startIso = parseDate(dateArg, todayIso);
  if (!startIso) fail(`couldn't understand the date "${dateArg}". Try e.g. 2026-11-20 or "20 Nov".`);
  if (!existsSync(file)) fail(`no file at ${file}.`);
  const dir = menusDir();

  let menu: MenuData;
  const ext = extname(file).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    menu = loadMenu(file);
  } else {
    menu = await extractWithLLM(readMenuText(file));
  }

  // Round-trip through the bot's own strict validator.
  const header =
    `# Mess menu live from ${startIso} (${prettyDate(startIso)}).\n` +
    `# Added ${todayIso} by plato-menu from ${basename(file)}. Week 1 = the week containing the go-live date.`;
  const text = toYaml(menu, header);
  const tmp = join(dir, `.${startIso}.yaml.tmp`);
  writeFileSync(tmp, text, { mode: 0o640 });
  try {
    menu = loadMenu(tmp);
  } catch (err) {
    unlinkSync(tmp);
    fail(`the menu didn't pass checks: ${(err as MenuError).message}`);
  }

  printMenu(menu);
  const target = join(dir, `${startIso}.yaml`);
  const replacing = existsSync(target);
  if (startIso <= todayIso) {
    console.log(`⚠ ${prettyDate(startIso)} is today or in the past: this menu takes over from the next post.`);
  }
  if (replacing) console.log(`⚠ This replaces the menu already scheduled for ${prettyDate(startIso)}.`);
  console.log("Check the dishes above against the original before saying yes.");
  const ok = yes || (await ask(`Schedule this menu to go live on ${prettyDate(startIso)}? [y/N] `)) === "y";
  if (!ok) {
    unlinkSync(tmp);
    console.log("Nothing saved.");
    return;
  }
  // rename() keeps the bot from ever reading a half-written file.
  renameSync(tmp, target);
  chmodSync(target, 0o640);
  console.log(`✓ Saved. Plato switches to this menu on ${prettyDate(startIso)}. (plato-menu list to see all)`);
}

function cmdList(): void {
  const todayIso = localTodayIso(TIMEZONE);
  const files = listMenuFiles(menusDir());
  if (files.length === 0) return void console.log("No menus yet.");
  for (const f of files) {
    console.log(`${prettyDate(f.startIso).padEnd(18)} ${statusOf(f.startIso, files, todayIso)}`);
  }
}

function findMenu(dateArg: string | undefined): { startIso: string; path: string } {
  const todayIso = localTodayIso(TIMEZONE);
  const files = listMenuFiles(menusDir());
  if (!dateArg) {
    const live = files.filter((f) => f.startIso <= todayIso).pop();
    if (!live) fail("no menu is live yet.");
    return live;
  }
  const startIso = parseDate(dateArg, todayIso);
  const hit = files.find((f) => f.startIso === startIso);
  if (!hit) fail(`no menu starts on ${dateArg}. See plato-menu list.`);
  return hit;
}

async function cmdRemove(dateArg: string, yes: boolean): Promise<void> {
  const todayIso = localTodayIso(TIMEZONE);
  const f = findMenu(dateArg);
  if (f.startIso <= todayIso) fail("that menu has already gone live; only scheduled ones can be removed.");
  const ok = yes || (await ask(`Remove the menu scheduled for ${prettyDate(f.startIso)}? [y/N] `)) === "y";
  if (!ok) return void console.log("Nothing removed.");
  unlinkSync(f.path);
  console.log("✓ Removed.");
}

const USAGE = `Usage:
  plato-menu <menu.pdf> <go-live date>   e.g. plato-menu ~/Downloads/menu.pdf "20 Nov"
  plato-menu list                        all menus and which one is live
  plato-menu show [date]                 print a menu (default: the live one)
  plato-menu remove <date>               remove a menu that hasn't gone live yet`;

async function main(): Promise<void> {
  dotenv.config({ path: process.env.PLATO_ENV ?? "/etc/plato/env", quiet: true } as never);
  const args = process.argv.slice(2).filter((a) => a !== "-y" && a !== "--yes");
  const yes = process.argv.includes("-y") || process.argv.includes("--yes");
  const [cmd, a1] = args;
  try {
    if (cmd === "list") return cmdList();
    if (cmd === "show") return printMenu(loadMenu(findMenu(a1).path));
    if (cmd === "remove") return await cmdRemove(a1 ?? fail(USAGE), yes);
    if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help" || args.length < 2) {
      console.log(USAGE);
      return;
    }
    await cmdAdd(cmd, args.slice(1).join(" "), yes);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

if (require.main === module) void main();
