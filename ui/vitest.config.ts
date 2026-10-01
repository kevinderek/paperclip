import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    css: { include: [/motion-tokens\.css/] },
    setupFiles: ["./vitest.setup.ts"],
    // Reden van deze pin, niet weghalen (REK-449):
    // React 19 exporteert `act` alleen uit de development-build. In de agent-image
    // staat `NODE_ENV=production`, dus zonder deze pin sterft elke toets die
    // `import { act } from "react"` doet op `TypeError: act is not a function`.
    // Dat is geen rode toets maar een meting van de omgeving, en het is stil: geen
    // warning, geen specifieke exitcode. `test.env` staat hier omdat deze pin ook
    // geldt wanneer vitest rechtstreeks als binaire wordt gestart
    // (`./node_modules/.bin/vitest run ...`); een pin alleen in de `scripts` van
    // package.json zou die aanroep niet dekken.
    env: {
      NODE_ENV: "test",
    },
  },
});
