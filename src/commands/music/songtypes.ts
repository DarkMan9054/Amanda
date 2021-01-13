/* eslint-disable require-await */
import Discord from "thunderstorm"
import fetch from "node-fetch"

import passthrough from "../../passthrough"
const { constants, reloader, frisky, config, ipc } = passthrough

const { Util } = Discord

import utils from "../../modules/utilities"
reloader.sync("./modules/utilities/index.js", utils)

import common from "./common.js"
reloader.sync("./commands/music/common.js", common)

const stationData = new Map([
	["original", {
		title: "Frisky Radio: Original",
		queue: "Frisky Radio: Original",
		client_name: "frisky",
		url: "http://stream.friskyradio.com/frisky_mp3_hi", // 44100Hz 2ch 128k MP3
		beta_url: "http://stream.friskyradio.com/frisky_mp3_hi" // 44100Hz 2ch 128k MP3
	}],
	["deep", {
		title: "Frisky Radio: Deep",
		queue: "Frisky Radio: Deep",
		client_name: "deep",
		url: "http://deep.friskyradio.com/friskydeep_acchi", // 32000Hz 2ch 128k MP3 (!)
		beta_url: "http://deep.friskyradio.com/friskydeep_aachi" // 32000Hz 2ch 128k MP3 (!)
	}],
	["chill", {
		title: "Frisky Radio: Chill",
		queue: "Frisky Radio: Chill",
		client_name: "chill",
		url: "http://chill.friskyradio.com/friskychill_mp3_high", // 44100Hz 2ch 128k MP3
		beta_url: "https://stream.chill.friskyradio.com/mp3_high" // 44100Hz 2ch 128k MP3
	}],
	["classics", {
		title: "Frisky Radio: Classics",
		queue: "Frisky Radio: Classics",
		client_name: "classics",
		url: "https://stream.classics.friskyradio.com/mp3_high", // 44100Hz 2ch 128k MP3
		beta_url: "https://stream.classics.friskyradio.com/mp3_high" // 44100Hz 2ch 128k MP3
	}]
])

export class Song {
	public title = ""
	public track = ""
	public lengthSeconds = -1
	public queueLine = ""
	public npUpdateFrequency = 0
	public noPauseReason = ""
	public error = ""
	public typeWhileGetRelated = true
	public id = ""
	public live = false
	public thumbnail: { src: string; width: number; height: number } = { src: "", width: 0, height: 0 }
	public queue: import("./queue").Queue | null = null
	public validated = false

	public constructor() {
		setTimeout(() => {
			if (this.validated == false) this.validationError("must call validate() in constructor")
		})
	}

	public toObject(): any {
		return {
			class: "Did not override generic toObject"
		}
	}

	public getState() {
		const object = this.toObject()
		return {
			title: this.title,
			length: this.lengthSeconds,
			thumbnail: this.thumbnail,
			live: this.live,
			class: object.class,
			id: object.id
		}
	}

	public getProgress(time: number, paused: boolean) {
		return ""
	}

	/**
	 * An array of Song objects from related songs
	 */
	public getRelated(): Promise<Song[]> {
		return Promise.resolve([])
	}

	/**
	 * Sendable data showing the related songs
	 */
	public showRelated(): Promise<string | Discord.MessageEmbed> {
		return Promise.resolve("This isn't a real song.")
	}
	public showLink() {
		return Promise.resolve(constants.baseURL)
	}
	/**
	 * Get sendable data with information about this song
	 */
	public showInfo(): Promise<string | Discord.MessageEmbed> {
		return Promise.resolve("This isn't a real song.")
	}

	public async getLyrics(): Promise<string | null> {
		const picked = common.genius.pickApart(this)
		if (!picked.artist || !picked.title) return null
		let lyrics
		try {
			lyrics = await common.genius.getLyrics(picked.title, picked.artist)
		} catch {
			lyrics = null
		}
		return lyrics
	}

	public validationError(message: string) {
		console.error(`Song validation error: ${this.constructor.name} ${message}`)
	}

	public validate() {
		["id", "track", "title", "queueLine", "npUpdateFrequency"].forEach(key => {
			// @ts-ignore
			if (!this[key]) this.validationError(`unset ${key}`)
		})
		;["getProgress", "getRelated", "showRelated", "showInfo", "toObject"].forEach(key => {
			// @ts-ignore
			if (this[key] === Song.prototype[key]) this.validationError(`unset ${key}`)
		})
		if (typeof (this.lengthSeconds) != "number" || this.lengthSeconds < 0) this.validationError("unset lengthSeconds")
		if (!this.thumbnail.src) this.validationError("unset thumbnail src")
		if (this.live === null) this.validationError("unset live")
		this.validated = true
	}

	/**
	 * Code to run to prepare the song for playback, such as fetching its `track`.
	 */
	public prepare() {
		return Promise.resolve()
	}

	/**
	 * Code to run after the song was regenerated from resuming a queue
	 */
	public resume() {
		return Promise.resolve()
	}

	/**
	 * Clean up event listeners and such when the song is removed
	 */
	public destroy() {
		return undefined
	}
}

export class YouTubeSong extends Song {
	public uploader?: string
	public related: import("../../modules/utilities/classes/AsyncValueCache")<any>
	public prepareCache: import("../../modules/utilities/classes/AsyncValueCache")<void>

	public constructor(id: string, title: string, lengthSeconds: number, track: string | null = null, uploader: string | undefined = undefined) {
		super()

		this.id = id
		this.thumbnail = {
			src: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
			width: 320,
			height: 180
		}
		this.title = title
		this.uploader = uploader
		this.lengthSeconds = lengthSeconds
		this.track = track || "!"
		this.queueLine = `**${this.title}** (${common.prettySeconds(this.lengthSeconds)})`
		this.npUpdateFrequency = 5000
		this.typeWhileGetRelated = true
		this.live = false

		this.related = new utils.AsyncValueCache(
			async (): Promise<any[]> => {
				return fetch(`${this.getInvidiousOrigin()}/api/v1/videos/${this.id}`).then(async data => {
					const json = await data.json()
					this.typeWhileGetRelated = false
					return json.recommendedVideos.filter((v: any) => v.lengthSeconds > 0).slice(0, 10)
				})
			})

		// eslint-disable-next-line require-await
		this.prepareCache = new utils.AsyncValueCache(async () => {
			if (this.track == "!") {
				if (config.use_invidious) { // Resolve track with Invidious
					let host = null
					let region = null
					if (this.queue) {
						host = common.nodes.getByID(this.queue.nodeID).host
						region = this.queue.guild.region
					}
					return common.invidious.getTrack(this.id, host as string, region || undefined).then(t => {
						this.track = t
					}).catch(error => {
						if (typeof error === "string") this.error = error
						else this.error = `${error.name} - ${error.message}`
					})
				} else { // Resolve track with Lavalink
					return common.getTracks(this.id, this.queue?.guild.region).then(tracks => {
						if (!tracks[0]) this.error = `No results for ID ${this.id}`
						else if (!tracks[0].track) this.error = `Missing track for ID ${this.id}`
						else {
							this.track = tracks[0].track
							if (tracks[0].info) this.uploader = tracks[0].info.author
						}
					}).catch(message => {
						this.error = message
					})
				}
			}
		})

		this.validate()
	}

	public toObject() {
		return {
			class: "YouTubeSong",
			id: this.id,
			title: this.title,
			lengthSeconds: this.lengthSeconds,
			track: this.track,
			uploader: this.uploader
		}
	}

	public getProgress(time: number, paused: boolean) {
		const max = this.lengthSeconds
		const rightTime = common.prettySeconds(max)
		if (time > max) time = max
		const leftTime = common.prettySeconds(time)
		const bar = utils.progressBar(18, time, max, paused ? " [PAUSED] " : "")
		return `\`[ ${leftTime} ${bar} ${rightTime} ]\``
	}

	public async getRelated() {
		const related = await this.related.get().catch(() => [])
		return related.map((v: any) => new YouTubeSong(v.videoId, v.title, v.lengthSeconds))
	}

	public async showRelated() {
		try {
			const related = await this.related.get()
			if (related.length) {
				return new Discord.MessageEmbed()
					.setTitle("Related content from YouTube")
					.setDescription(
						related.map((v: any, i: any) => `${i + 1}. **${Util.escapeMarkdown(v.title)}** (${common.prettySeconds(v.lengthSeconds)})`
							+ `\n — ${v.author}`
						)
					)
					.setFooter("Play one of these? &music related play <number>, or &m rel p <number>")
					.setColor(constants.standard_embed_color)
			} else {
				return "No related content available for the current song."
			}
		} catch {
			this.typeWhileGetRelated = false
			return `Invidious didn't return valid data.\
				\n<${this.getInvidiousOrigin()}/api/v1/videos/${this.id}>\
				\n<${this.getInvidiousOrigin()}/v/${this.id}>\
				\n<https://youtu.be/${this.id}>`
		}
	}
	public getInvidiousOrigin() {
		return common.nodes.getByID(this.queue!.nodeID).invidious_origin
	}
	public showLink() {
		return this.showInfo()
	}

	public showInfo() {
		return Promise.resolve(`https://www.youtube.com/watch?v=${this.id}`)
	}

	public prepare() {
		return this.prepareCache.get()
	}

	public resume() {
		return Promise.resolve()
	}

	public destroy() {
		return undefined
	}
}

export class FriskySong extends Song {
	public station: any
	public stationData: {
		title: string; queue: string; client_name: string;
		url: string // 44100Hz 2ch 128k MP3
		beta_url: string // 44100Hz 2ch 128k MP3
	} | undefined
	public friskyStation: any
	public stationInfoGetter: import("../../modules/utilities/classes/AsyncValueCache")<any>
	private _filledBarOffset: number
	public bound: any

	constructor(station: string, data: any = {}) {
		super()

		this.station = station

		if (!stationData.has(this.station)) throw new Error(`Unsupported station: ${this.station}`)
		this.stationData = stationData.get(this.station)

		this.id = `frisky/${this.station}` // designed for error reporting
		this.thumbnail = {
			src: constants.frisky_placeholder,
			width: 320,
			height: 180
		}
		this.title = this.stationData?.title || "Frisky"
		this.queueLine = `**${this.stationData?.queue}** (LIVE)`
		this.track = data.track || "!"
		this.lengthSeconds = 0
		this.npUpdateFrequency = 15000
		this.typeWhileGetRelated = false
		this.noPauseReason = "You can't pause live radio."
		this.live = true

		this.friskyStation = frisky.managers.stream.stations.get(this.stationData?.client_name)
		this.stationInfoGetter = new utils.AsyncValueCache(
			// @ts-ignore
			(): Promise<import("frisky-client/lib/Stream")> => new Promise((resolve, reject) => {
				let attempts = 0

				const attempt = () => {
					const retry = (reason: any) => {
						if (attempts < 5) {
							setTimeout(() => {
								attempt()
							}, 1000)
						} else {
							reject(reason)
						}
					}

					attempts++
					const index = this.friskyStation.findNowPlayingIndex()
					if (index == null) return retry("Current item is unknown")
					const stream = this.friskyStation.getSchedule()[index]
					if (!stream) return retry("Current stream not available")
					if (!stream.mix) return retry("Current mix not available")
					if (!stream.mix.data) return retry("Current mix data not available")
					const episode = stream.mix.episode
					if (!episode) return retry("Current episode not available")
					if (!episode.data) return retry("Current episode data not available")
					// console.log("Retrieved Frisky station data in "+(Date.now()-time)+"ms")
					return resolve(stream)
				}
				attempt()
			})
		)

		this._filledBarOffset = 0

		this.validate()
	}

	public toObject() {
		return {
			class: "FriskySong",
			station: this.station,
			track: this.track
		}
	}

	public getRelated() {
		return Promise.resolve([])
	}

	public showRelated() {
		return Promise.resolve("Try the other stations on Frisky Radio! `&frisky`, `&frisky deep`, `&frisky chill`")
	}

	public showLink() {
		return this.stationInfoGetter.get().then(stream => {
			return `https://beta.frisky.fm/mix/${stream.mix.id}`
		}).catch(() => "https://beta.frisy.fm")
	}

	public showInfo() {
		return this.stationInfoGetter.get().then(stream => {
			const mix = stream.mix
			const stationCase = this.station[0].toUpperCase() + this.station.slice(1).toLowerCase()
			let percentPassed = Math.floor(((-stream.getTimeUntil()) / (stream.data.duration * 1000)) * 100)
			if (percentPassed < 0) percentPassed = 0
			if (percentPassed > 100) percentPassed = 100
			const embed = new Discord.MessageEmbed()
				.setColor(constants.standard_embed_color)
				.setTitle(`FRISKY: ${mix.data.title}`)
				.setURL(`https://beta.frisky.fm/mix/${mix.id}`)
				.addFields({
					name: "Details",
					value: utils.tableifyRows(
						[
							["Episode", `${mix.data.title} / [view](https://beta.frisky.fm/mix/${mix.id})`],
							["Show", `${mix.data.title.split(" - ")[0]} / [view](https://beta.frisky.fm/shows/${mix.data.show_id.id})`],
							["Genre", mix.data.genre.join(", ")],
							["Station", stationCase],
							["Schedule", `started ${utils.shortTime(-stream.getTimeUntil(), "ms", ["d", "h", "m"])} ago, ${utils.shortTime(stream.getTimeUntil() + stream.data.duration * 1000, "ms", ["d", "h", "m"])} remaining (${percentPassed}%)`]
						],
						["left", "left"],
						() => "`"
					)
				})
			if (mix.episode) {
				embed.setThumbnail(this.thumbnail.src)
			}
			if (mix.data.track_list && mix.data.track_list.length) {
				let trackList = mix.data.track_list
					.slice(0, 6)
					.map((track: any) => `${track.artist} - ${track.title}`)
					.join("\n")
				const hidden = mix.data.track_list.length - 6
				if (hidden > 0) trackList += `\n_and ${hidden} more..._`
				embed.addFields({ name: "Track list", value: trackList })
			}
			return embed
		})
	}

	public getProgress(time: number) {
		const part = "= ⋄ ==== ⋄ ==="
		const fragment = part.substr(7 - this._filledBarOffset, 7)
		const bar = `${fragment.repeat(3)}` // SC: ZWSP x 2
		this._filledBarOffset++
		if (this._filledBarOffset >= 7) this._filledBarOffset = 0
		// eslint-disable-next-line no-irregular-whitespace
		return `\`[ ${common.prettySeconds(time)} ​${bar}​ LIVE ]\`` // SC: ZWSP x 2
	}

	public async prepare() {
		if (!this.bound) {
			this.bound = this.stationUpdate.bind(this)
			this.friskyStation.events.addListener("changed", this.bound)
			await this.stationUpdate()
		}
		if (this.track == "!") {
			let mp3URL = this.stationData!.beta_url
			if (this.station === "chill") mp3URL = this.stationData!.url
			return common.getTracks(mp3URL, this.queue!.guild.region).then(tracks => {
				if (tracks[0] && tracks[0].track) this.track = tracks[0].track
				else {
					console.error(tracks)
					this.error = `No tracks available for station ${this.station}`
				}
			}).catch(message => {
				this.error = message
			})
		} else return Promise.resolve()
	}

	public async stationUpdate() {
		this.stationInfoGetter.clear()
		try {
			const stream = await this.stationInfoGetter.get()
			const mix = stream.mix
			// console.log(mix)
			this.title = mix.data.title
			this.thumbnail.src = mix.episode.data.album_art.url
			this.thumbnail.width = mix.episode.data.album_art.image_width
			this.thumbnail.height = mix.episode.data.album_art.image_height
			if (this.queue) {
				const index = this.queue.songs.indexOf(this)
				if (index !== -1) ipc.replier?.sendSongUpdate(this.queue, this, index)
			}
		} catch (reason) {
			console.error(reason)
		}
	}

	public resume() {
		return this.prepare()
	}

	public destroy() {
		if (this.bound) this.friskyStation.events.removeListener("changed", this.bound)
		return undefined
	}
}

export class SoundCloudSong extends Song {
	public artist: any
	public trackNumber: any
	public uri: any

	public constructor(data: import("../../typings").LavalinkInfo, track: string) {
		super()

		this.title = data.title
		this.track = track
		this.artist = data.author
		this.lengthSeconds = Math.floor(data.length / 1000)
		this.queueLine = `**${this.title}** (${common.prettySeconds(this.lengthSeconds)})`
		this.npUpdateFrequency = 5000
		this.error = ""
		this.typeWhileGetRelated = false
		const match = data.identifier.match(/soundcloud:tracks:(\d+)/)
		if (match) this.trackNumber = match[1]
		this.id = `sc/${this.trackNumber}`
		this.live = data.isStream || false
		this.thumbnail = {
			src: constants.soundcloud_placeholder,
			width: 616,
			height: 440
		}
		this.uri = data.uri

		this.validate()
	}

	public getProgress(time: number, paused: boolean) {
		const max = this.lengthSeconds
		const rightTime = common.prettySeconds(max)
		if (time > max) time = max
		const leftTime = common.prettySeconds(time)
		const bar = utils.progressBar(18, time, max, paused ? " [PAUSED] " : "")
		return `\`[ ${leftTime} ${bar} ${rightTime} ]\``
	}

	public getRelated() {
		return Promise.resolve([])
	}

	public showRelated() {
		return Promise.resolve("Try finding related songs on SoundCloud.")
	}

	public showLink() {
		return this.showInfo()
	}

	public showInfo() {
		return Promise.resolve(this.uri)
	}

	public toObject() {
		return {
			class: "SoundCloudSong",
			id: this.id,
			trackNumber: this.trackNumber,
			title: this.title,
			lengthSeconds: this.lengthSeconds,
			track: this.track,
			uri: this.uri,
			live: this.live
		}
	}

	public getState() {
		return Object.assign(super.getState(), { trackNumber: this.trackNumber })
	}
}

// @ts-ignore
export class SpotifySong extends YouTubeSong {
	public trackNumber: number
	public uri: string
	public artist: string

	public constructor(data: import("../../typings").SpotifyTrack & { track?: string, youtubeID?: string }) {
		super(data.youtubeID || "!", data.name, Math.floor(data.duration_ms / 1000))

		this.trackNumber = data.track_number
		this.live = false
		this.thumbnail = data.album && data.album.images[0] ? { src: data.album.images[0].url, width: data.album.images[0].width, height: data.album.images[0].height } : { src: constants.spotify_placeholder, width: 386, height: 386 }
		this.uri = data.uri
		this.typeWhileGetRelated = false
		// @ts-ignore
		this.related = []
		this.artist = data.artists[0].name
		const youtubePrepareCache = this.prepareCache
		this.prepareCache = new utils.AsyncValueCache(async () => {
			if (this.id == "!" || this.track == "!") {
				return common.searchYouTube(`${this.artist} - ${this.title}`, this.queue!.guild.region).then(tracks => {
					if (!tracks.length) this.error = `No results for ${this.title}`
					let decided
					const found = tracks.find(item => item.info && item.info.author.includes("- Topic"))
					if (found) decided = found
					else decided = tracks[0]
					if (!decided.track) this.error = `Missing track for ${this.title}`
					else {
						this.id = decided.info.identifier
						this.lengthSeconds = Math.round(decided.info.length / 1000)
						this.queueLine = `**${this.title}** (${common.prettySeconds(this.lengthSeconds)})`
						ipc.replier!.sendSongTimeUpdate(this.queue!, this.queue!.songs.indexOf(this), this.lengthSeconds)
						return youtubePrepareCache.get()
					}
				}).catch(message => {
					this.error = message
				})
			}
		})

		this.validate()
	}

	public toObject() {
		return {
			class: "SpotifySong",
			trackNumber: this.trackNumber,
			durationMS: this.lengthSeconds * 1000,
			lengthSeconds: this.lengthSeconds,
			uploader: this.artist,
			title: this.title,
			uri: this.uri,
			artist: this.artist,
			id: this.id,
			track: this.track
		}
	}

	public getRelated() {
		return Promise.resolve([])
	}

	public showRelated() {
		return Promise.resolve("Try finding related songs on Spotify.")
	}

	public showLink() {
		const ID = this.uri.match(/spotify:track:([\d\w]+)/)![1]
		return Promise.resolve(`https://open.spotify.com/track/${ID}`)
	}

	public async showInfo() {
		const SP = await this.showLink()
		const YT = await super.showInfo()
		return Promise.resolve(`${SP}\n${YT}`)
	}

	public prepare() {
		return this.prepareCache.get()
	}
}

export class ExternalSong extends Song {
	public uri: string
	private _filledBarOffset: number

	public constructor(link: string) {
		super()

		const to = new URL(link)
		let name
		const pathnamereg = /\/?(\w+)\.\w+/
		const match = to.pathname.match(pathnamereg)
		if (!match) name = "Unknown Track"
		else name = match[1]
		this.title = name.replace(/_/g, " ")
		this.live = true
		this.thumbnail = {
			src: constants.local_placeholder,
			width: 616,
			height: 440
		}
		this.uri = link
		this.track = "!"
		this.lengthSeconds = 0
		this.npUpdateFrequency = 15000
		this.queueLine = `**${this.title}** (LIVE)`
		this.typeWhileGetRelated = false
		this.noPauseReason = "You can't pause external audio."
		this.id = String(Date.now())
		this._filledBarOffset = 0

		this.validate()
	}

	public async prepare() {
		let info
		try {
			info = await common.getTracks(this.uri, this.queue!.guild.region)
		} catch {
			this.error = `Missing track for ${this.title}`
			return
		}
		if (!Array.isArray(info) || !info || !info[0] || !info[0].track) this.error = `Missing track for ${this.title}`
		this.track = info[0].track
		if (info[0].info.isSeekable) {
			this.live = false
			this.lengthSeconds = Math.round(info[0].info.length / 1000)
			this.queueLine = `**${this.title}** (${common.prettySeconds(this.lengthSeconds)})`
			this.noPauseReason = ""
			ipc.replier!.sendSongTimeUpdate(this.queue!, this.queue!.songs.indexOf(this), this.lengthSeconds)
		}
	}

	public toObject() {
		return {
			class: "ExternalSong",
			lengthSeconds: this.lengthSeconds,
			uri: this.uri,
			id: this.id,
			track: this.track
		}
	}

	public getRelated() {
		return Promise.resolve([])
	}

	public showRelated() {
		return Promise.resolve("Try finding related songs on other websites")
	}

	public showLink() {
		return Promise.resolve(this.uri)
	}

	public showInfo() {
		return this.showLink()
	}

	public getProgress(time: number, paused: boolean) {
		let bar
		const leftTime = common.prettySeconds(time)
		const rightTime = this.live ? "LIVE" : common.prettySeconds(this.lengthSeconds)
		if (this.live) {
			const part = "= ⋄ ==== ⋄ ==="
			const fragment = part.substr(7 - this._filledBarOffset, 7)
			bar = `${fragment.repeat(3)}` // SC: ZWSP x 2
			this._filledBarOffset++
			if (this._filledBarOffset >= 7) this._filledBarOffset = 0
		} else {
			if (time > this.lengthSeconds) time = this.lengthSeconds
			bar = utils.progressBar(18, time, this.lengthSeconds, paused ? " [PAUSED] " : "")
		}
		return `\`[ ${leftTime} ​${bar}​ ${rightTime} ]\`` // SC: ZWSP x 2
	}

	public resume() {
		return this.prepare()
	}
}

export class ListenMoeSong extends Song {
	public station: "jp" | "kp"
	public stationData: import("listensomemoe")
	public uri: string
	private _filledBarOffset: number

	public constructor(station: "jp" | "kp") {
		super()

		this.station = station
		this.stationData = passthrough.listenMoe[station]
		this.live = true
		this.thumbnail = {
			src: constants.listen_moe_placeholder,
			width: 64,
			height: 64
		}
		this.uri = this.stationData.Constants.STREAM_URLS[station === "jp" ? "JPOP" : "KPOP"].vorbis
		this.track = "!"
		this.npUpdateFrequency = 15000
		this.typeWhileGetRelated = false
		this.noPauseReason = "You can't pause live audio."
		this._filledBarOffset = 0

		this.validate()
	}

	// @ts-ignore
	public get lengthSeconds() {
		return this.stationData.nowPlaying.duration
	}
	public set lengthSeconds(value) {
		void value
	}

	// @ts-ignore
	public get id() {
		return String((this.stationData.nowPlaying.albums && this.stationData.nowPlaying.albums[0] ? (this.stationData.nowPlaying.albums[0].id || this.stationData.nowPlaying.id) : this.stationData.nowPlaying.id))
	}
	public set id(value) {
		void value
	}

	// @ts-ignore
	public get title() {
		return this.stationData.nowPlaying.title
	}
	public set title(value) {
		void value
	}

	// @ts-ignore
	public get queueLine() {
		return `**${this.title}** (${this.lengthSeconds ? common.prettySeconds(this.lengthSeconds) : "LIVE"})`
	}
	public set queueLine(value) {
		void value
	}

	public async prepare() {
		let info
		try {
			info = await common.getTracks(this.uri, this.queue!.guild.region)
		} catch {
			this.error = `Missing track for ${this.title}`
			return
		}
		if (!Array.isArray(info) || !info || !info[0] || !info[0].track) this.error = `Missing track for ${this.title}`
		this.track = info[0].track
	}

	public toObject() {
		return {
			class: "ListenMoeSong",
			station: this.station,
			lengthSeconds: this.lengthSeconds,
			uri: this.uri,
			id: this.id,
			track: this.track
		}
	}

	public getRelated() {
		return Promise.resolve([])
	}

	public showRelated() {
		return Promise.resolve("Try the other stations on <https://listen.moe>")
	}

	public showLink() {
		return Promise.resolve(`https://listen.moe/albums/${this.id}`)
	}

	public async showInfo() {
		const link = await this.showLink()
		return `https://listen.moe\n${link}`
	}

	public getProgress(fallback: number) {
		let time
		if (this.stationData.lastTrackStartedAt) time = Math.floor((Date.now() - this.stationData.lastTrackStartedAt) / 1000)
		else time = fallback
		const part = "= ⋄ ==== ⋄ ==="
		const fragment = part.substr(7 - this._filledBarOffset, 7)
		let bar
		if (!this.lengthSeconds) bar = `${fragment.repeat(3)}` // SC: ZWSP x 2
		else {
			if (time > this.lengthSeconds) time = this.lengthSeconds
			bar = utils.progressBar(18, time, this.lengthSeconds)
		}
		this._filledBarOffset++
		if (this._filledBarOffset >= 7) this._filledBarOffset = 0
		return `\`[ ${common.prettySeconds(time)} ​${bar}​ ${this.lengthSeconds ? common.prettySeconds(this.lengthSeconds) : "LIVE"} ]\`` // SC: ZWSP x 2
	}

	public resume() {
		return this.prepare()
	}
}

export class NewgroundsSong extends Song {
	public author: string
	public uri: string
	public streamURL: string

	public constructor(data: { href: string, author: string, title: string, id: number, mp3URL: string, duration: number, track?: string }) {
		super()

		this.title = data.title
		this.author = data.author
		this.uri = data.href
		this.streamURL = data.mp3URL
		this.id = String(data.id)
		this.live = false
		this.lengthSeconds = data.duration
		this.thumbnail = {
			src: constants.newgrounds_placeholder,
			width: 1200,
			height: 1200
		}
		this.track = data.track || "!"
		this.queueLine = `**${this.title}** (${common.prettySeconds(this.lengthSeconds)})`
		this.npUpdateFrequency = 5000
		this.error = ""
		this.typeWhileGetRelated = false

		this.validate()
	}

	public toObject() {
		return {
			class: "NewgroundsSong",
			href: this.uri,
			title: this.title,
			author: this.author,
			id: this.id,
			mp3URL: this.streamURL,
			duration: this.lengthSeconds,
			track: this.track
		}
	}

	public getRelated() {
		return Promise.resolve([])
	}

	public showRelated() {
		return Promise.resolve("Try finding related songs on NewGrounds")
	}

	public async prepare() {
		if (this.track && this.track != "!") return
		let data
		try {
			data = await common.getTracks(this.streamURL, this.queue!.guild.region)
		} catch {
			this.error = `Missing track for ${this.title}`
			return
		}
		if (!Array.isArray(data) || !data || !data[0] || !data[0].track) this.error = `Missing track for ${this.title}`
		this.track = data[0].track
	}

	public showLink() {
		return Promise.resolve(this.uri)
	}

	public showInfo() {
		return this.showLink()
	}

	public getProgress(time: number, paused: boolean) {
		const max = this.lengthSeconds
		const rightTime = common.prettySeconds(max)
		if (time > max) time = max
		const leftTime = common.prettySeconds(time)
		const bar = utils.progressBar(18, time, max, paused ? " [PAUSED] " : "")
		return `\`[ ${leftTime} ${bar} ${rightTime} ]\``
	}
}

export function makeYouTubeSongFromData(data: { track: string, info: { identifier: string, title: string, length: number, author: string } }) {
	return new YouTubeSong(data.info.identifier, data.info.title, Math.round(data.info.length / 1000), data.track || null, data.info.author)
}


export function makeSoundCloudSong(trackNumber: string, title: string, lengthSeconds: number, live: boolean, uri: string, track: string) {
	// @ts-ignore
	return new SoundCloudSong({
		identifier: `soundcloud:tracks:${trackNumber}`,
		title: title,
		length: lengthSeconds * 1000,
		isStream: live,
		uri: uri
	}, track)
}

export function makeSpotifySong(data: import("../../typings").SpotifyTrack, id: string | undefined = undefined, track: string | undefined = undefined) {
	if (id) Object.assign(data, { youtubeID: id })
	if (track) Object.assign(data, { track: track })
	return new SpotifySong(data)
}


export function makeExternalSong(link: string) {
	return new ExternalSong(link)
}

export function makeListenMoeSong(station: "jp" | "kp") {
	return new ListenMoeSong(station)
}

export function makeNewgroundsSong(data: { href: string, author: string, title: string, id: number, mp3URL: string, duration: number, track?: string }) {
	return new NewgroundsSong(data)
}

export default { makeYouTubeSongFromData, Song, YouTubeSong, FriskySong, SoundCloudSong, makeSoundCloudSong, SpotifySong, makeSpotifySong, ExternalSong, makeExternalSong, ListenMoeSong, makeListenMoeSong, NewgroundsSong, makeNewgroundsSong }