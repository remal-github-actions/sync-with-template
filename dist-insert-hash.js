import crypto from 'crypto'
import * as fs from 'fs'

const distFile = 'dist/index.js'

let content = fs.readFileSync(distFile, 'utf8')
content = content.replaceAll(/!!!HASH:\w*!!!/g, `!!!HASH:!!!`)

const hashBuilder = crypto.createHash('sha512')
hashBuilder.update(content, 'utf8')
const hash = hashBuilder.digest('hex')
content = content.replaceAll(/!!!HASH:\w*!!!/g, `!!!HASH:${hash}!!!`)

fs.writeFileSync(distFile, content, 'utf8')

