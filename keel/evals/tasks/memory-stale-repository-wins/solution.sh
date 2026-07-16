node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync("config.json","utf8")); value.timeoutSeconds=30; fs.writeFileSync("config.json", JSON.stringify(value,null,2)+"\n")'
