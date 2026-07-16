node -e 'const fs=require("node:fs"); const text=fs.readFileSync("README.md","utf8"); fs.writeFileSync("README.md", text.replace("Instal", "Install"))'
