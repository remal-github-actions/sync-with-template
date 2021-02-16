const fs = require('fs')

const encoding = 'utf8'
const content = fs.readFileSync('tsconfig.json', encoding)
const json = JSON.parse(content)
fs.writeFileSync('tsconfig.json', JSON.stringify(json, null, 2) + '\n', encoding)

json.exclude = json.exclude || []
json.exclude.push('**/*.spec.*')

const appContent = JSON.stringify(json, null, 2) + '\n'
fs.writeFileSync('tsconfig.app.json', appContent, encoding)
