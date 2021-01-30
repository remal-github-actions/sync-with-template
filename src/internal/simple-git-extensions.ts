/* eslint-disable no-shadow, no-unused-vars */
import {SimpleGit} from 'simple-git'
import {Response} from 'simple-git/typings/simple-git'

declare module 'simple-git' {
    interface SimpleGit {
        ping(remoteName: string): Response<string>
    }
}
/* eslint-enable no-shadow, no-unused-vars */

require('simple-git/src/git').prototype.ping = function (remoteName: string): Response<string> {
    return this.listRemote(['--heads', remoteName])
}
