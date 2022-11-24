import type { PluginContext } from '@rcv-prod-toolkit/types'
import fetch from 'node-fetch'
import { createWriteStream, createReadStream, existsSync } from 'fs'
import { stat, mkdir, writeFile } from 'fs/promises'
import { copy, remove } from 'fs-extra'
import { join } from 'path'
import { x } from 'tar'
import { get } from 'https'
import { SingleBar, MultiBar } from 'cli-progress'

type IPluginContext = PluginContext & {
  progress?: MultiBar
  setProgressBar?: (percent: number, state?: string) => void
}

export default class StaticData {
  private readyHandler?: () => void

  private _finishedCenteredImg = false
  private _finishedAdditionalFileDownloading = false
  private _finishedDragonTail = false

  public version?: string

  private versionIndex = 0

  /**
   * @param ctx Plugin Context
   * @param config
   */
  constructor(private ctx: IPluginContext, private config: any) {
    this._startUp()
  }

  private async _startUp() {
    if (!this.config.gameVersion) {
      await this.setCurrentVersion()
    } else {
      this.version = this.config.gameVersion
    }

    if (
      !this.config['last-downloaded-version'] ||
      this.config['last-downloaded-version'] !== this.version
    ) {
      try {
        await this.getAdditionalFiles()
        await this.getDDragon()
      } catch (error) {
        this._errorReadyCheck()
        return
      }
    } else {
      this._finishedCenteredImg = true
      this._finishedAdditionalFileDownloading = true
      this._finishedDragonTail = true

      if (this.readyHandler) this.readyHandler()
    }
  }

  public onReady(handler: () => void): void {
    if (
      this._finishedDragonTail &&
      this._finishedCenteredImg &&
      this._finishedAdditionalFileDownloading
    ) {
      handler()
    } else {
      this.readyHandler = handler
    }
  }

  private _readyCheck() {
    if (!this.readyHandler) return

    if (
      !this._finishedDragonTail ||
      !this._finishedCenteredImg ||
      !this._finishedAdditionalFileDownloading
    )
      return

    this.readyHandler()
    this._setDownloadVersion()
  }

  private _errorReadyCheck() {
    if (!this.readyHandler) return

    if (
      !this.config['last-downloaded-version'] ||
      this.config['last-downloaded-version'] === ''
    ) {
      this.ctx.log.warn(
        'The latest patch information could not be downloaded. Trying to get data from an earlier patch'
      )
      this.versionIndex += 1
      return this._startUp()
    }

    this.ctx.log.warn(
      `The latest patch information could not be downloaded, data from the previous patch (${this.config['last-downloaded-version']}) will be used`
    )

    this.readyHandler()
  }

  private _setDownloadVersion() {
    this.ctx.LPTE.emit({
      meta: {
        type: 'set',
        namespace: 'plugin-config',
        version: 1
      },
      config: {
        'last-downloaded-version': this.version
      }
    })
  }

  private async setCurrentVersion() {
    const gvRequest = await fetch(
      'https://ddragon.leagueoflegends.com/api/versions.json'
    )
    const gvJson = (await gvRequest.json()) as any
    return (this.version = gvJson[this.versionIndex] as string)
  }

  private async getDDragon() {
    const tarFileName = `dragontail-${this.version}.tgz`
    const tarFilePath = join(__dirname, '..', 'frontend', tarFileName)
    const tarURI = `https://ddragon.leagueoflegends.com/cdn/${tarFileName}`

    const res = await fetch(tarURI)

    if (!res.ok) {
      return this._errorReadyCheck()
    }

    const file = createWriteStream(tarFilePath)
    this.ctx.log.info('start downloading dragontail.tgz')
    let progress: SingleBar

    get(tarURI, (response) => {
      response.pipe(file)

      if (response.headers['content-length']) {
        var len = parseInt(response.headers['content-length'], 10)
        var cur = 0
        var total = len / 1048576

        if (progress === undefined) {
          if (typeof this.ctx.progress?.create === 'function') {
            progress = this.ctx.progress.create(Math.round(total), 0, {
              task: 'downloading DataDragon'
            })
          } else if (typeof this.ctx.setProgressBar === 'function') {
            this.ctx.setProgressBar(0, 'Downloading DataDragon')
          }
        }

        response.on('data', (chunk: any) => {
          cur += chunk.length
          if (progress !== undefined) {
            progress.update(Math.round(cur / 1048576))
          } else if (typeof this.ctx.setProgressBar === 'function') {
            this.ctx.setProgressBar(
              cur / 1048576 / total,
              'Downloading DataDragon'
            )
          }
        })
      }

      file.on('finish', () => {
        this.ctx.log.info('\n finish downloading dragontail.tgz')
        file.close()
        progress?.stop()
        this.unpackDDragon()
      })
    }).on('error', async (err) => {
      progress?.stop() // Handle errors
      try {
        await remove(tarFilePath)
        this.ctx.log.error(err.message)
        this._errorReadyCheck()
      } catch (error: any) {
        this.ctx.log.debug(`\n${tarFilePath}file removed`)
      }
    })
  }

  private async unpackDDragon() {
    const tarFileName = `dragontail-${this.version}.tgz`
    const tarFilePath = join(__dirname, '..', 'frontend', tarFileName)
    const stats = await stat(tarFilePath)

    if (stats === undefined || stats.size <= 0) {
      return this._errorReadyCheck()
    }

    const dDragonPaths = [
      `${this.version}/img/champion`,
      `${this.version}/img/item`,
      `${this.version}/img/profileicon`,
      `${this.version}/data/en_US/map.json`,
      `${this.version}/data/en_US/runesReforged.json`,
      `${this.version}/data/en_US/champion.json`,
      `${this.version}/data/en_US/item.json`,
      `img/champion`,
      `img/perk-images/Styles`
    ]

    const dataPath = join(__dirname, '..', 'frontend')

    this.ctx.log.info('start unpacking dragontail.tgz')
    createReadStream(tarFilePath)
      .pipe(
        x({ cwd: dataPath, newer: true }, dDragonPaths)
          .on('finish', async () => {
            this.ctx.log.info('finish unpacking dragontail.tgz')
            await remove(tarFilePath)
            this.copyDDragonFiles()
          })
          .on('error', (e) => {
            this.ctx.log.error(e)
            this._errorReadyCheck()
          })
      )
      .on('error', (e) => {
        this.ctx.log.error(e)
        this._errorReadyCheck()
      })
  }

  private async copyDDragonFiles() {
    this.ctx.log.info('moving files to frontend')

    const dataPath = join(__dirname, '..', 'frontend')
    const versionDirPath = join(
      __dirname,
      '..',
      'frontend',
      this.version as string
    )

    await copy(versionDirPath, dataPath)

    this.removeVersionDir()
    this.getAllCenteredImg()

    this.ctx.log.info('finish moving files to frontend')
  }

  private async removeVersionDir() {
    this.ctx.log.info('delete versioned folder')
    const versionDirPath = join(
      __dirname,
      '..',
      'frontend',
      this.version as string
    )
    await remove(versionDirPath)
    this._finishedDragonTail = true
    this._readyCheck()
    this.ctx.log.info('finish deleting versioned folder')
  }

  private async getAllCenteredImg() {
    this.ctx.log.info('start downloading centered images')

    const base = join(
      __dirname,
      '..',
      'frontend',
      'img',
      'champion',
      'centered'
    )

    if (!existsSync(base)) {
      await mkdir(base, { recursive: true })
    }

    const champions: Array<any> = Object.values(
      require(`../frontend/data/en_US/champion.json`).data
    )

    try {
      await Promise.all(
        champions.map(async (champ) => {
          const champId = champ.key
          return await this._downloadCenteredImg(base, champId)
        })
      )
    } catch (error) {
      this.ctx.log.error(error)
      this._errorReadyCheck()
    }

    this._finishedCenteredImg = true
    this._readyCheck()
    this.ctx.log.info('finish downloading centered images')
  }

  private async _downloadCenteredImg(base: string, champId: number) {
    const dest = join(base, champId.toString()) + '.jpg'
    const url = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-splashes/${champId}/${champId}000.jpg`

    let file = createWriteStream(dest)
    get(url, (response) => {
      response.pipe(file)
      file.on('finish', () => {
        file.close()
        this.ctx.log.debug(`downloaded img for ${champId}`)
        return Promise.resolve(true)
      })
    }).on('error', async (err) => {
      try {
        await remove(dest)
        this.ctx.log.error(
          `downloaded failed img for ${champId} with: ${err.message}`
        )
        return Promise.reject(err)
      } catch (error: any) {
        this.ctx.log.error(error)
        return Promise.reject(error)
      }
    })
  }

  private async getAdditionalFiles() {
    if (!this.version) return
    this.ctx.log.info('start downloading additional files')

    try {
      await Promise.all([
        await this.getItemBin(),
        await this.getConstants('gameModes'),
        await this.getConstants('gameTypes'),
        await this.getConstants('queues'),
        await this.getConstants('seasons'),
        await this.getConstants('maps')
      ])

      this._finishedAdditionalFileDownloading = true
      this._readyCheck()
      this.ctx.log.info('finish downloading additional files')
    } catch (error: any) {
      this.ctx.log.debug(error)
      throw new Error(error)
    }
  }

  async getConstants(name: string) {
    const base = join(__dirname, '..', 'frontend', 'data', 'constants')

    if (!existsSync(base)) {
      await mkdir(base)
    }

    const filePath = join(base, `${name}.json`)

    const uri = `https://static.developer.riotgames.com/docs/lol/${name}.json`
    const res = await fetch(uri)
    const data = await res.json()

    if (!res.ok) {
      this.ctx.log.debug(`${name} could not be downloaded`)
      throw new Error(res.statusText)
    }

    return writeFile(filePath, JSON.stringify(data))
  }

  async getItemBin() {
    const base = join(__dirname, '..', 'frontend', 'data')

    if (!existsSync(base)) {
      await mkdir(base)
    }

    const filePath = join(base, 'item.bin.json')

    const versionSplit = (this.version as string).split('.')
    const mainVersion = `${versionSplit[0]}.${versionSplit[1]}`
    const uri = `https://raw.communitydragon.org/${mainVersion}/game/global/items/items.bin.json`
    const res = await fetch(uri)
    const data = await res.json()

    if (!res.ok) {
      this.ctx.log.debug('item.bin could not be downloaded')
      throw new Error(res.statusText)
    }

    return writeFile(filePath, JSON.stringify(data))
  }
}
