function splitCommandLine(input) {
  const text = String(input || "").trim();
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("Unclosed quote in command");
  }

  if (escaping) {
    current += "\\";
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseOptions(tokens) {
  const args = [];
  const options = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token.startsWith("--") || token === "--") {
      args.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex !== -1) {
      const key = withoutPrefix.slice(0, equalsIndex);
      options[key] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = tokens[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[withoutPrefix] = next;
      index += 1;
    } else {
      options[withoutPrefix] = true;
    }
  }

  return { args, options };
}

function parseSlashCommand(input) {
  const text = String(input || "").trim();

  if (!text) {
    return { name: "empty", args: [], options: {}, raw: text };
  }

  if (!text.startsWith("/")) {
    throw new Error("unknown input. q-gagarin CLI accepts slash commands only. Try /help.");
  }

  const tokens = splitCommandLine(text);
  const rawName = tokens.shift();
  const name = rawName.slice(1).toLowerCase();
  const { args, options } = parseOptions(tokens);

  if (!name) {
    throw new Error("Missing slash command. Try /help.");
  }

  return {
    name,
    args,
    options,
    raw: text,
  };
}

module.exports = {
  parseOptions,
  parseSlashCommand,
  splitCommandLine,
};
