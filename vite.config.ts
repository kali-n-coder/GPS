import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? "/GPS/" : "/",
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "firebase",
              test: /node_modules[\\/](@firebase|firebase)[\\/]/,
              maxSize: 450_000,
              priority: 20,
            },
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom)[\\/]/,
              priority: 15,
            },
          ],
        },
      },
    },
  },
});
