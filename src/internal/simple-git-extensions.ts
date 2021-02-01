/* eslint-disable no-shadow, no-unused-vars */
import {SimpleGit} from 'simple-git'
import {Response} from 'simple-git/typings/simple-git'

declare module 'simple-git' {
    interface SimpleGit {
        ping(remoteName: string): Response<string>

        installLfs(): Response<string>
    }
}
/* eslint-enable no-shadow, no-unused-vars */

const Git = require('simple-git/src/git')

Git.prototype.ping = function (remoteName: string): Response<string> {
    return this.listRemote(['--exit-code', '--heads', remoteName])
}

Git.prototype.installLfs = function (): Response<string> {
    return this.raw(['lfs', 'install', '--local'])
}
