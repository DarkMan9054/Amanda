//@ts-check

const rp = require("request-promise")
const Discord = require("discord.js")
const path = require("path")

const passthrough = require("../../passthrough")
let {client, reloader} = passthrough

let utils = require("../../modules/utilities.js")
reloader.useSync("./modules/utilities.js", utils)

let lang = require("../../modules/lang.js")
reloader.useSync("./modules/lang.js", lang)

class VoiceStateCallback {
	/**
	 * @param {Discord.Message} msg
	 * @param {number} timeoutMs
	 * @param {(voiceChannel: Discord.VoiceChannel) => any} callback
	 * @constructor
	 */
	constructor(msg, timeoutMs, callback) {
		this.msg = msg
		this.timeout = setTimeout(() => this.cancel(), timeoutMs)
		this.callback = callback
		this.active = true
		common.voiceStateCallbackManager.getAll(this.msg.author.id, this.msg.guild).forEach(o => o.cancel())
		this.add()
	}
	add() {
		common.voiceStateCallbackManager.callbacks.push(this)
	}
	remove() {
		let index = common.voiceStateCallbackManager.callbacks.indexOf(this)
		if (index != -1) common.voiceStateCallbackManager.callbacks.splice(index, 1)
	}
	/**
	 * @param {Discord.VoiceChannel} voiceChannel
	 */
	trigger(voiceChannel) {
		if (this.active) {
			let checkedVoiceChannel = common.verifyVoiceChannel(voiceChannel, this.msg)
			if (checkedVoiceChannel) {
				// All good!
				this.active = false
				clearTimeout(this.timeout)
				this.remove()
				this.callback(voiceChannel)
			}
			// Else, couldn't join or speak. We'll keep this active in case they switch channels.
		}
	}
	cancel() {
		if (this.active) {
			this.active = false
			clearTimeout(this.timeout)
			this.remove()
			this.callback(null)
		}
	}
}

let common = {
	/**
	 * @param {Discord.TextChannel|Discord.DMChannel} channel
	 * @param {Object} reason
	 * @param {string} reason.message
	 * @param {string} id
	 * @param {number} item
	 * @returns {Promise<Discord.Message>}
	 */
	manageYtdlGetInfoErrors: function(channel, reason, id, item) {
		if (channel instanceof Discord.Message) channel = channel.channel
		let idString = id ? ` (index: ${item}, id: ${id})` : ""
		if (!reason || !reason.message) {
			return channel.send("An unknown error occurred."+idString)
		} if (reason.message && reason.message.startsWith("No video id found:")) {
			return channel.send(`That is not a valid YouTube video.`+idString)
		} else if (reason.message && (
				reason.message.includes("who has blocked it in your country")
			|| reason.message.includes("This video is unavailable")
			|| reason.message.includes("The uploader has not made this video available in your country")
			|| reason.message.includes("copyright infringement")
		)) {
			return channel.send(`I'm not able to stream that video. It may have been deleted by the creator, made private, blocked in certain countries, or taken down for copyright infringement.`+idString);
		} else {
			return new Promise(resolve => {
				utils.stringify(reason).then(result => {
					channel.send(result).then(resolve)
				})
			})
		}
	},

	/**
	 * @param {number} seconds
	 */
	prettySeconds: function(seconds) {
		let minutes = Math.floor(seconds / 60)
		seconds = seconds % 60
		let hours = Math.floor(minutes / 60)
		minutes = minutes % 60
		let output = []
		if (hours) {
			output.push(hours)
			output.push(minutes.toString().padStart(2, "0"))
		} else {
			output.push(minutes)
		}
		output.push(seconds.toString().padStart(2, "0"))
		return output.join(":")
	},

	inputToID:
	/**
	 * @param {string} input
	 * @returns {({type: string, id?: string, list?: string})|null}
	 */
	function(input) {
		input = input.replace(/(<|>)/g, "")
		try {
			let inputAsURL = input
			if (inputAsURL.includes(".com/") && !inputAsURL.startsWith("http")) inputAsURL = "https://"+inputAsURL
			const url = new URL(inputAsURL)
			// It's a URL.
			if (url.hostname.startsWith("www.")) url.hostname = url.hostname.slice(4)
			// Is it CloudTube?
			if (url.hostname == "cadence.moe" || url.hostname == "cadence.gq") {
				try {
					const id = url.pathname.match(/video\/([\w-]{11})$/)[1]
					// Got an ID!
					return {type: "video", id: id}
				} catch (e) {
					// Didn't match.
					return null
				}
			}
			// Is it youtu.be?
			else if (url.hostname == "youtu.be") {
				const id = url.pathname.slice(1)
				return {type: "video", id: id}
			}
			// Is it YouTube-compatible?
			else if (url.hostname == "youtube.com" || url.hostname == "invidio.us" || url.hostname == "hooktube.com") {
				// Is it a playlist?
				if (url.searchParams.get("list")) {
					let result = {type: "playlist", list: url.searchParams.get("list")}
					const id = url.searchParams.get("v")
					if (id) result.id = id
					return result
				}
				// Is it a video?
				else if (url.pathname == "/watch") {
					const id = url.searchParams.get("v")
					// Got an ID!
					return {type: "video", id: id}
				}
				// YouTube-compatible, but can't resolve to a video.
				else {
					return null
				}
			}
			// Unknown site.
			else {
				return null
			}
		} catch (e) {
			// Not a URL. Might be an ID?
			if (input.match(/^[A-Za-z0-9_-]{11}$/)) return {type: "video", id: input}
			else return null
		}
	},

	/**
	 * Call /loadtracks on the first node using the passed identifier.
	 * @param {string} input
	 * @returns {Promise<{track: string, info: {identifier: string, isSeekable: boolean, author: string, length: number, isStream: boolean, position: number, title: string, uri: string}}[]>}
	 */
	getTracks: async function(input) {
		const node = client.lavalink.nodes.first()

		const params = new URLSearchParams()
		params.append("identifier", input)

		return rp({
			url: `http://${node.host}:${node.port}/loadtracks?${params.toString()}`,
			headers: {
				"Authorization": node.password
			},
			json: true
		}).then(data => data.tracks)
	},

	invidious: {
		/**
		 * @param {string} id
		 */
		getData: function(id) {
			return rp(`https://invidio.us/api/v1/videos/${id}`, {json: true})
		},

		dataToURL: function(data) {
			let formats = data && data.adaptiveFormats
			if (!formats) return null
			formats = formats
			.filter(f => f.type.includes("audio"))
			.sort((a, b) => (b.bitrate - a.bitrate))
			if (formats[0]) return formats[0].url
			else return null
		},

		urlToTrack: function(url) {
			return common.getTracks(url).then(tracks => {
				if (!tracks || !tracks.length) return null
				return tracks[0].track
			})
		},

		/**
		 * @param {string} id
		 * @returns {Promise<string>}
		 */
		getTrack: function(id) {
			return common.invidious.getData(id)
			.then(common.invidious.dataToURL)
			.then(common.invidious.urlToTrack)
			.catch(error => {
				console.error(error)
				return null
			})
		}
	},

	inserters: {
		handleSong:
		/**
		 * @param {import("./songtypes").Song} song
		 * @param {Discord.TextChannel} textChannel
		 * @param {Discord.VoiceChannel} voiceChannel
		 * @param {boolean} insert
		 * @param {Discord.Message} [context]
		 */
		function(song, textChannel, voiceChannel, insert = false, context) {
			let queue = passthrough.queueStore.getOrCreate(voiceChannel, textChannel)
			let result = queue.addSong(song, insert)
			if (context instanceof Discord.Message && result == 0) {
				context.react("✅")
			}
		},

		fromData:
		/**
		 * @param {Discord.TextChannel} textChannel
		 * @param {Discord.VoiceChannel} voiceChannel
		 * @param {any} data
		 * @param {boolean} insert
		 * @param {Discord.Message} [context]
		 */
		function(textChannel, voiceChannel, data, insert, context) {
			const songTypes = require("./songtypes")
			let song = songTypes.makeYouTubeSongFromData(data)
			common.inserters.handleSong(song, textChannel, voiceChannel, insert, context)
		},


		fromDataArray:
		/**
		 * @param {Discord.TextChannel} textChannel
		 * @param {Discord.VoiceChannel} voiceChannel
		 * @param {any[]} data
		 * @param {boolean} insert
		 * @param {Discord.Message} [context]
		 */
		function(textChannel, voiceChannel, data, insert, context) {
			const songTypes = require("./songtypes")
			let songs = data.map(item => songTypes.makeYouTubeSongFromData(item))
			common.inserters.fromSongArray(textChannel, voiceChannel, songs, insert, context)
		},

		fromSongArray:
		/**
		 * @param {Discord.TextChannel} textChannel
		 * @param {Discord.VoiceChannel} voiceChannel
		 * @param {any[]} songs
		 * @param {boolean} insert
		 * @param {Discord.Message} [context]
		 */
		function(textChannel, voiceChannel, songs, insert, context) {
			if (insert) songs.reverse()
			songs.forEach(song => {
				common.inserters.handleSong(song, textChannel, voiceChannel, insert, context)
			})
		},

		fromSearch:
		/**
		 * @param {Discord.TextChannel} textChannel
		 * @param {Discord.VoiceChannel} voiceChannel
		 * @param {Discord.User} author
		 * @param {boolean} insert
		 * @param {string} search
		 */
		async function(textChannel, voiceChannel, author, insert, search) {
			let tracks = await common.getTracks("ytsearch:"+search)
			if (tracks.length == 0) return textChannel.send("No results.")
			tracks = tracks.slice(0, 10)
			let results = tracks.map((track, index) => `${index+1}. **${Discord.Util.escapeMarkdown(track.info.title)}** (${common.prettySeconds(track.info.length/1000)})`)
			utils.makeSelection(textChannel, author.id, "Song selection", "Song selection cancelled", results).then(index => {
				if (typeof(index) != "number") return
				let track = tracks[index]
				let song = new (require("./songtypes").YouTubeSong)(track.info.identifier, track.info.title, Math.floor(track.info.length/1000))
				common.inserters.handleSong(song, textChannel, voiceChannel, insert)
			})
		}
	},

	voiceStateCallbackManager: {
		/**
		 * @type {VoiceStateCallback[]}
		 */
		callbacks: [],
		/**
		 * @param {string} userID
		 * @param {Discord.Guild} guild
		 * @returns {VoiceStateCallback[]}
		 */
		getAll: function(userID, guild) {
			return this.callbacks.filter(o => o.msg.author.id == userID && o.msg.guild == guild)
		}
	},

	VoiceStateCallback,

	/**
	 * @param {Discord.Message} msg
	 * @param {number} timeoutMs
	 * @returns {Promise<Discord.VoiceChannel>}
	 */
	getPromiseVoiceStateCallback: function(msg, timeoutMs) {
		return new Promise(resolve => {
			new common.VoiceStateCallback(msg, timeoutMs, voiceChannel => resolve(voiceChannel))
		})
	},

	/**
	 * Find the member that sent a message and get their voice channel.
	 * If `wait` is set, then wait 30 seconds for them to connect.
	 * Returns a promise that eventually resolves to a voice channel, or null (if they didn't join in time)
	 * **This responds to the user on failure, and also checks if the client has permission to join and speak.**
	 * @param {Discord.Message} msg
	 * @param {boolean} wait If false, return immediately. If true, wait up to 30 seconds for the member to connect.
	 * @returns {Promise<(Discord.VoiceChannel|null)>}
	 */
	detectVoiceChannel: async function(msg, wait) {
		// Already in a voice channel? Use that!
		if (msg.member.voice.channel) return common.verifyVoiceChannel(msg.member.voice.channel, msg)
		// Not in a voice channel, and not waiting? Quit.
		if (!wait) {
			msg.channel.send(lang.voiceMustJoin(msg))
			return null
		}
		// Tell the user to join.
		let prompt = await msg.channel.send(lang.voiceChannelWaiting(msg))
		// Return a promise which waits for them.
		return common.getPromiseVoiceStateCallback(msg, 30000).then(voiceChannel => {
			if (voiceChannel) {
				prompt.delete()
				return voiceChannel
			} else {
				prompt.edit(lang.voiceMustJoin(msg))
				return null
			}
		})
	},

	/**
	 * Checks if the client can join and speak in the voice channel.
	 * If it can, return the voice channel.
	 * If it can't, send an error in chat and return null.
	 * @param {Discord.VoiceChannel} voiceChannel Voice channel to check
	 * @param {Discord.Message} msg Message to direct errors at
	 * @return {(Discord.VoiceChannel|null)}
	 */
	verifyVoiceChannel: function(voiceChannel, msg) {
		if (!voiceChannel.joinable) {
			msg.channel.send(lang.voiceCannotJoin(msg))
			return null
		}
		if (!voiceChannel.speakable) {
			msg.channel.send(lang.voiceCannotSpeak(msg))
			return null
		}
		// All good!
		return voiceChannel
	}
}

utils.addTemporaryListener(client, "voiceStateUpdate", path.basename(__filename), (oldState, newState) => {
	// Process waiting to join
	// If someone else changed state, and their new state has a channel (i.e. just joined or switched channel)
	if (newState.id != client.user.id && newState.channel) {
		// Trigger all callbacks for that user in that guild
		common.voiceStateCallbackManager.getAll(newState.id, newState.guild).forEach(state => state.trigger(newState.channel))
	}
})

module.exports = common
