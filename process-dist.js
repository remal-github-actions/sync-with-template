import * as fs from 'fs'
import * as path from 'path'

const distPath = 'dist'
const fileNames = fs.readdirSync(distPath, { recursive: true })
for (const fileName of fileNames) {
    const filePath = path.join(distPath, fileName)
    if (!filePath.endsWith('.js') || !fs.statSync(filePath).isFile()) {
        continue
    }

    let content = fs.readFileSync(filePath, 'utf8')

    content = `const __dirname = import.meta.dirname;\n${content}`

    fs.writeFileSync(filePath, content, 'utf8')
}
