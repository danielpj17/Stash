import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        charcoal: {
          DEFAULT: "#1A1A1A",
          light: "#282828",
          dark: "#333333",
        },
        tileRowAlt: "#2C2C2C",
        accent: {
          DEFAULT: "#59D58E",
          light: "#6EE0A0",
          dark: "#3BC77A",
        },
      },
    },
  },
  plugins: [],
};

export default config;
