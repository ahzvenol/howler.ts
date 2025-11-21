/**
 * Howler.js v2.2.4 (Core) - TypeScript Port
 *
 *  howler.js v2.2.4
 *  howlerjs.com
 *
 *  (c) 2013-2020, James Simpson of GoldFire Studios
 *  goldfirestudios.com
 *
 *  MIT License
 */

export type HowlCallback = (soundId: number) => void
export type HowlErrorCallback = (soundId: number, error: unknown) => void

export type SoundSpriteDefinitions = {
    [name: string]: [number, number] | [number, number, boolean]
}

export interface HowlOptions {
    src: string | string[]
    volume?: number
    html5?: boolean
    loop?: boolean
    preload?: boolean | 'metadata'
    autoplay?: boolean
    mute?: boolean
    sprite?: SoundSpriteDefinitions
    rate?: number
    pool?: number
    format?: string | string[]
    xhr?: {
        method?: string
        headers?: Record<string, string>
        withCredentials?: boolean
    }
    onload?: HowlCallback
    onloaderror?: HowlErrorCallback
    onplayerror?: HowlErrorCallback
    onplay?: HowlCallback
    onend?: HowlCallback
    onpause?: HowlCallback
    onstop?: HowlCallback
    onmute?: HowlCallback
    onvolume?: HowlCallback
    onrate?: HowlCallback
    onseek?: HowlCallback
    onfade?: HowlCallback
    onunlock?: HowlCallback
}

// --- Legacy Browser Compatibility Types ---

// IOS Safari Legacy State
type LegacyAudioContextState = AudioContextState | 'interrupted'

// Older Web Audio API syntax
type LegacyAudioContext = Omit<AudioContext, 'state' | 'close'> & {
    createGainNode?(): GainNode
    state: LegacyAudioContextState
    close?(): Promise<void>
}

// HTML5 Audio with internal unlock flag
interface HowlerAudioElement extends HTMLAudioElement {
    _unlocked?: boolean
    bufferSource?: AudioBufferSourceNode
}

interface LegacyAudioBufferSourceNode extends AudioBufferSourceNode {
    noteOn?(when: number): void
    noteGrainOn?(when: number, grainOffset: number, grainDuration: number): void
    noteOff?(when: number): void
}

// AudioNode with internal BufferSource reference
interface HowlerGainNode extends GainNode {
    paused?: boolean
    bufferSource?: LegacyAudioBufferSourceNode
}

// Promise-like return for play() on older browsers
type PlayReturn = Promise<void> | undefined

// Global Cache for AudioBuffers
const bufferCache: Record<string, AudioBuffer> = {}

/** Single Sound Methods **/
/***************************************************************************/

/**
 * Setup the sound object, which each node attached to a Howl group is contained in.
 * @param {Object} howl The Howl parent group.
 */
export class Sound {
    /** @internal */ public _parent: Howl
    /** @internal */ public _id: number
    /** @internal */ public _muted: boolean
    /** @internal */ public _loop: boolean
    /** @internal */ public _volume: number
    /** @internal */ public _rate: number
    /** @internal */ public _seek: number
    /** @internal */ public _paused: boolean
    /** @internal */ public _ended: boolean
    /** @internal */ public _sprite: string
    /** @internal */ public _node: HowlerAudioElement | HowlerGainNode | null
    /** @internal */ public _playStart: number
    /** @internal */ public _rateSeek: number
    /** @internal */ public _start: number
    /** @internal */ public _stop: number
    /** @internal */ public _fadeTo: number | null
    /** @internal */ public _interval: any // Timer ID

    // Event Listeners
    /** @internal */ public _errorFn?: () => void
    /** @internal */ public _loadFn?: () => void
    /** @internal */ public _endFn?: () => void

    constructor(howl: Howl) {
        this._parent = howl

        // Init Logic
        /**
         * Initialize a new Sound object.
         * @return {Sound}
         */
        this._muted = howl._muted
        this._loop = howl._loop
        this._volume = howl._volume
        this._rate = howl._rate
        this._seek = 0
        this._paused = true
        this._ended = true
        this._sprite = '__default'
        this._id = ++Howler._counter
        this._rateSeek = 0
        this._playStart = 0
        this._start = 0
        this._stop = 0
        this._fadeTo = null
        this._node = null

        // Add itself to the parent's pool.
        howl._sounds.push(this)

        // Create the new node.
        this.create()
    }

    /**
     * Create and setup a new sound object, whether HTML5 Audio or Web Audio.
     * @return {Sound}
     */
    public create(): this {
        const parent = this._parent
        const volume = Howler._muted || this._muted || parent._muted ? 0 : this._volume

        if (parent._webAudio && Howler.ctx) {
            const ctx = Howler.ctx

            // Create the gain node for controlling volume (the source will connect to this).
            const gain = typeof ctx.createGain === 'undefined' ? ctx.createGainNode!() : ctx.createGain()

            this._node = gain as HowlerGainNode
            this._node.gain.setValueAtTime(volume, Howler.ctx.currentTime)
            this._node.paused = true
            this._node.connect(Howler.masterGain!)
        } else if (!Howler.noAudio) {
            // Get an unlocked Audio object from the pool.
            this._node = Howler._obtainHtml5Audio()

            // Listen for errors (http://dev.w3.org/html5/spec-author-view/spec.html#mediaerror).
            this._errorFn = this._errorListener.bind(this)
            this._node.addEventListener('error', this._errorFn, false)

            // Listen for 'canplaythrough' event to let us know the sound is ready.
            this._loadFn = this._loadListener.bind(this)
            this._node.addEventListener(Howler._canPlayEvent, this._loadFn, false)

            // Listen for the 'ended' event on the sound to account for edge-case where
            // a finite sound has a duration of Infinity.
            this._endFn = this._endListener.bind(this)
            this._node.addEventListener('ended', this._endFn, false)

            // Setup the new audio node.
            this._node.src = parent._src as string
            // Explicitly handle boolean conversion to string for preload
            this._node.preload =
                parent._preload === true ? 'auto' : parent._preload === 'metadata' ? 'metadata' : 'auto'
            this._node.volume = volume * Howler.volume()

            // Begin loading the source.
            this._node.load()
        }
        return this
    }

    /**
     * Reset the parameters of this sound to the original state (for recycle).
     * @return {Sound}
     */
    public reset(): this {
        const parent = this._parent
        // Reset all of the parameters of this sound.
        this._muted = parent._muted
        this._loop = parent._loop
        this._volume = parent._volume
        this._rate = parent._rate
        this._seek = 0
        this._rateSeek = 0
        this._paused = true
        this._ended = true
        this._sprite = '__default'

        // Generate a new ID so that it isn't confused with the previous sound.
        this._id = ++Howler._counter
        return this
    }

    /**
     * HTML5 Audio error listener callback.
     */
    /** @internal */
    public _errorListener(): void {
        const node = this._node as HowlerAudioElement
        // Fire an error event and pass back the code.
        this._parent._emit('loaderror', this._id, node.error ? node.error.code : 0)

        // Clear the event listener.
        if (this._errorFn) node.removeEventListener('error', this._errorFn, false)
    }

    /**
     * HTML5 Audio canplaythrough listener callback.
     */
    /** @internal */
    public _loadListener(): void {
        const parent = this._parent
        const node = this._node as HowlerAudioElement

        // Round up the duration to account for the lower precision in HTML5 Audio.
        parent._duration = Math.ceil(node.duration * 10) / 10

        // Setup a sprite if none is defined.
        if (Object.keys(parent._sprite).length === 0) {
            parent._sprite = { __default: [0, parent._duration * 1000] }
        }

        if (parent.state() !== 'loaded') {
            parent._state = 'loaded'
            parent._emit('load')
            parent._loadQueue()
        }

        // Clear the event listener.
        if (this._loadFn) node.removeEventListener(Howler._canPlayEvent, this._loadFn, false)
    }

    /**
     * HTML5 Audio ended listener callback.
     */
    /** @internal */
    public _endListener(): void {
        const parent = this._parent
        const node = this._node as HowlerAudioElement

        // Only handle the `ended`` event if the duration is Infinity.
        if (parent._duration === Infinity) {
            // Update the parent duration to match the real audio duration.
            // Round up the duration to account for the lower precision in HTML5 Audio.
            parent._duration = Math.ceil(node.duration * 10) / 10

            // Update the sprite that corresponds to the real duration.
            if (parent._sprite.__default[1] === Infinity) {
                parent._sprite.__default[1] = parent._duration * 1000
            }

            // Run the regular ended method.
            parent._ended(this)
        }

        // Clear the event listener since the duration is now correct.
        if (this._endFn) node.removeEventListener('ended', this._endFn, false)
    }
}

/** Global Methods **/
/***************************************************************************/

/**
 * Create the global controller. All contained methods and properties apply
 * to all sounds that are currently playing or will be in the future.
 */
class HowlerGlobal {
    /** @internal */ public _counter: number = 1000
    /** @internal */ public _html5AudioPool: HowlerAudioElement[] = []
    public html5PoolSize: number = 10
    /** @internal */ public _codecs: Record<string, boolean> = {}
    /** @internal */ public _howls: Howl[] = []
    /** @internal */ public _muted: boolean = false
    /** @internal */ public _volume: number = 1
    /** @internal */ public _canPlayEvent: string = 'canplaythrough'
    /** @internal */ public _navigator: any =
        typeof window !== 'undefined' && window.navigator ? window.navigator : null

    public masterGain: GainNode | null = null
    public noAudio: boolean = false
    public usingWebAudio: boolean = true
    public autoSuspend: boolean = true
    public ctx: LegacyAudioContext | null = null
    public autoUnlock: boolean = true

    /** @internal */ public _audioUnlocked: boolean = false
    /** @internal */ public _mobileUnloaded: boolean = false
    /** @internal */ public _scratchBuffer: AudioBuffer | null = null
    public state: string = 'suspended'

    /** @internal */ public _suspendTimer: any = null
    /** @internal */ public _resumeAfterSuspend: boolean = false

    constructor() {
        this._setup()
    }

    // --- Public API ---

    /**
     * Get/set the global volume for all sounds.
     * @param  {Float} vol Volume from 0.0 to 1.0.
     * @return {Howler/Float}     Returns self or current volume.
     */
    public volume(): number
    public volume(volume: number): this
    public volume(vol?: number): number | this {
        // If we don't have an AudioContext created yet, run the setup.
        if (!this.ctx) this._setupAudioContext()

        if (typeof vol !== 'undefined' && vol >= 0 && vol <= 1) {
            this._volume = vol

            // Don't update any of the nodes if we are muted.
            if (this._muted) return this

            // When using Web Audio, we just need to adjust the master gain.
            if (this.usingWebAudio && this.masterGain) {
                this.masterGain.gain.setValueAtTime(vol, this.ctx!.currentTime)
            }

            // Loop through and change volume for all HTML5 audio nodes.
            for (let i = 0; i < this._howls.length; i++) {
                if (!this._howls[i]._webAudio) {
                    // Get all of the sounds in this Howl group.
                    const ids = this._howls[i]._getSoundIds()

                    // Loop through all sounds and change the volumes.
                    for (let j = 0; j < ids.length; j++) {
                        const sound = this._howls[i]._soundById(ids[j])
                        if (sound && sound._node) {
                            ;(sound._node as HTMLAudioElement).volume = sound._volume * vol
                        }
                    }
                }
            }
            return this
        }
        return this._volume
    }

    /**
     * Handle muting and unmuting globally.
     * @param  {Boolean} muted Is muted or not.
     */
    public mute(muted: boolean): this {
        // If we don't have an AudioContext created yet, run the setup.
        if (!this.ctx) this._setupAudioContext()
        this._muted = muted

        // With Web Audio, we just need to mute the master gain.
        if (this.usingWebAudio && this.masterGain) {
            this.masterGain.gain.setValueAtTime(muted ? 0 : this._volume, this.ctx!.currentTime)
        }

        // Loop through and mute all HTML5 Audio nodes.
        for (let i = 0; i < this._howls.length; i++) {
            if (!this._howls[i]._webAudio) {
                // Get all of the sounds in this Howl group.
                const ids = this._howls[i]._getSoundIds()

                // Loop through all sounds and mark the audio node as muted.
                for (let j = 0; j < ids.length; j++) {
                    const sound = this._howls[i]._soundById(ids[j])
                    if (sound && sound._node) {
                        ;(sound._node as HTMLAudioElement).muted = muted ? true : sound._muted
                    }
                }
            }
        }
        return this
    }

    /**
     * Handle stopping all sounds globally.
     */
    public stop(): this {
        // Loop through all Howls and stop them.
        for (let i = 0; i < this._howls.length; i++) {
            this._howls[i].stop()
        }
        return this
    }

    /**
     * Unload and destroy all currently loaded Howl objects.
     * @return {Howler}
     */
    public unload(): this {
        for (let i = this._howls.length - 1; i >= 0; i--) {
            this._howls[i].unload()
        }

        // Create a new AudioContext to make sure it is fully reset.
        if (this.usingWebAudio && this.ctx && typeof this.ctx.close !== 'undefined') {
            this.ctx.close()
            this.ctx = null
            this._setupAudioContext()
        }
        return this
    }

    /**
     * Check for codec support of specific extension.
     * @param  {String} ext Audio file extention.
     * @return {Boolean}
     */
    public codecs(ext: string): boolean {
        return this._codecs[ext.replace(/^x-/, '')]
    }

    // --- Internal Setup ---

    /**
     * Setup various state values for global tracking.
     */
    /** @internal */
    public _setup(): void {
        // Keeps track of the suspend/resume state of the AudioContext.
        this.state = this.ctx ? this.ctx.state || 'suspended' : 'suspended'

        // Automatically begin the 30-second suspend process
        this._autoSuspendLogic()

        // Check if audio is available.
        if (!this.usingWebAudio) {
            // No audio is available on this system if noAudio is set to true.
            if (typeof Audio !== 'undefined') {
                try {
                    const test = new Audio()

                    // Check if the canplaythrough event is available.
                    if (typeof test.oncanplaythrough === 'undefined') {
                        this._canPlayEvent = 'canplay'
                    }
                } catch (e) {
                    this.noAudio = true
                }
            } else {
                this.noAudio = true
            }
        }

        // Test to make sure audio isn't disabled in Internet Explorer.
        try {
            const test = new Audio()
            if (test.muted) {
                this.noAudio = true
            }
        } catch (e) {}

        // Check for supported codecs.
        if (!this.noAudio) {
            this._setupCodecs()
        }
    }

    /**
     * Check for browser support for various codecs and cache the results.
     */
    /** @internal */
    public _setupCodecs(): void {
        let audioTest: HTMLAudioElement | null = null

        // Must wrap in a try/catch because IE11 in server mode throws an error.
        try {
            audioTest = typeof Audio !== 'undefined' ? new Audio() : null
        } catch (err) {
            return
        }

        if (!audioTest || typeof audioTest.canPlayType !== 'function') return

        const mpegTest = audioTest.canPlayType('audio/mpeg;').replace(/^no$/, '')

        // Opera version <33 has mixed MP3 support, so we need to check for and block it.
        const ua = this._navigator ? this._navigator.userAgent : ''
        const checkOpera = ua.match(/OPR\/(\d+)/g)
        const isOldOpera = checkOpera && parseInt(checkOpera[0].split('/')[1], 10) < 33
        const checkSafari = ua.indexOf('Safari') !== -1 && ua.indexOf('Chrome') === -1
        const safariVersion = ua.match(/Version\/(.*?) /)
        const isOldSafari = checkSafari && safariVersion && parseInt(safariVersion[1], 10) < 15

        this._codecs = {
            mp3: !!(!isOldOpera && (mpegTest || audioTest.canPlayType('audio/mp3;').replace(/^no$/, ''))),
            mpeg: !!mpegTest,
            opus: !!audioTest.canPlayType('audio/ogg; codecs="opus"').replace(/^no$/, ''),
            ogg: !!audioTest.canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, ''),
            oga: !!audioTest.canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, ''),
            wav: !!(audioTest.canPlayType('audio/wav; codecs="1"') || audioTest.canPlayType('audio/wav')).replace(
                /^no$/,
                ''
            ),
            aac: !!audioTest.canPlayType('audio/aac;').replace(/^no$/, ''),
            caf: !!audioTest.canPlayType('audio/x-caf;').replace(/^no$/, ''),
            m4a: !!(
                audioTest.canPlayType('audio/x-m4a;') ||
                audioTest.canPlayType('audio/m4a;') ||
                audioTest.canPlayType('audio/aac;')
            ).replace(/^no$/, ''),
            m4b: !!(
                audioTest.canPlayType('audio/x-m4b;') ||
                audioTest.canPlayType('audio/m4b;') ||
                audioTest.canPlayType('audio/aac;')
            ).replace(/^no$/, ''),
            mp4: !!(
                audioTest.canPlayType('audio/x-mp4;') ||
                audioTest.canPlayType('audio/mp4;') ||
                audioTest.canPlayType('audio/aac;')
            ).replace(/^no$/, ''),
            weba: !!(!isOldSafari && audioTest.canPlayType('audio/webm; codecs="vorbis"').replace(/^no$/, '')),
            webm: !!(!isOldSafari && audioTest.canPlayType('audio/webm; codecs="vorbis"').replace(/^no$/, '')),
            dolby: !!audioTest.canPlayType('audio/mp4; codecs="ec-3"').replace(/^no$/, ''),
            flac: !!(audioTest.canPlayType('audio/x-flac;') || audioTest.canPlayType('audio/flac;')).replace(/^no$/, '')
        }
    }

    /**
     * Setup the audio context when available, or switch to HTML5 Audio mode.
     */
    /** @internal */
    public _setupAudioContext(): void {
        // If we have already detected that Web Audio isn't supported, don't run this step again.
        if (!this.usingWebAudio) return

        // Check if we are using Web Audio and setup the AudioContext if we are.
        try {
            if (typeof AudioContext !== 'undefined') {
                this.ctx = new AudioContext() as LegacyAudioContext
            } else if (typeof (window as any).webkitAudioContext !== 'undefined') {
                this.ctx = new (window as any).webkitAudioContext() as LegacyAudioContext
            } else {
                this.usingWebAudio = false
            }
        } catch (e) {
            this.usingWebAudio = false
        }

        // If the audio context creation still failed, set using web audio to false.
        if (!this.ctx) {
            this.usingWebAudio = false
        }

        // Check if a webview is being used on iOS8 or earlier (rather than the browser).
        // If it is, disable Web Audio as it causes crashing.
        const iOS = /iP(hone|od|ad)/.test(this._navigator && this._navigator.platform)
        const appVersion = this._navigator && this._navigator.appVersion.match(/OS (\d+)_(\d+)_?(\d+)?/)
        const version = appVersion ? parseInt(appVersion[1], 10) : null
        if (iOS && version && version < 9) {
            const safari = /safari/.test(this._navigator && this._navigator.userAgent.toLowerCase())
            if (this._navigator && !safari) {
                this.usingWebAudio = false
            }
        }

        // Create and expose the master GainNode when using Web Audio (useful for plugins or advanced usage).
        if (this.usingWebAudio && this.ctx) {
            const ctx = this.ctx
            this.masterGain = typeof ctx.createGain === 'undefined' ? ctx.createGainNode!() : ctx.createGain()
            this.masterGain.gain.setValueAtTime(this._muted ? 0 : this._volume, this.ctx.currentTime)
            this.masterGain.connect(this.ctx.destination)
        }

        // Re-run the setup on Howler.
        this._setup()
    }

    /**
     * Some browsers/devices will only allow audio to be played after a user interaction.
     * Attempt to automatically unlock audio on the first user interaction.
     * Concept from: http://paulbakaus.com/tutorials/html5/web-audio-on-ios/
     */
    /** @internal */
    public _unlockAudio(): void {
        // Only run this if Web Audio is supported and it hasn't already been unlocked.
        if (this._audioUnlocked || !this.ctx) return

        this._audioUnlocked = false
        this.autoUnlock = false

        // Some mobile devices/platforms have distortion issues when opening/closing tabs and/or web views.
        // Bugs in the browser (especially Mobile Safari) can cause the sampleRate to change from 44100 to 48000.
        // By calling Howler.unload(), we create a new AudioContext with the correct sampleRate.
        if (!this._mobileUnloaded && this.ctx.sampleRate !== 44100) {
            this._mobileUnloaded = true
            this.unload()
        }

        // Scratch buffer for enabling iOS to dispose of web audio buffers correctly, as per:
        // http://stackoverflow.com/questions/24119684
        this._scratchBuffer = this.ctx.createBuffer(1, 1, 22050)

        // Call this method on touch start to create and play a buffer,
        // then check if the audio actually played to determine if
        // audio has now been unlocked on iOS, Android, etc.
        const unlock = () => {
            // Create a pool of unlocked HTML5 Audio objects that can
            // be used for playing sounds without user interaction. HTML5
            // Audio objects must be individually unlocked, as opposed
            // to the WebAudio API which only needs a single activation.
            // This must occur before WebAudio setup or the source.onended
            // event will not fire.
            while (this._html5AudioPool.length < this.html5PoolSize) {
                try {
                    const audioNode = new Audio() as HowlerAudioElement
                    // Mark this Audio object as unlocked to ensure it can get returned
                    // to the unlocked pool when released.
                    audioNode._unlocked = true

                    // Add the audio node to the pool.
                    this._releaseHtml5Audio(audioNode)
                } catch (e) {
                    this.noAudio = true
                    break
                }
            }

            // Loop through any assigned audio nodes and unlock them.
            for (let i = 0; i < this._howls.length; i++) {
                if (!this._howls[i]._webAudio) {
                    // Get all of the sounds in this Howl group.
                    const ids = this._howls[i]._getSoundIds()

                    // Loop through all sounds and unlock the audio nodes.
                    for (let j = 0; j < ids.length; j++) {
                        const sound = this._howls[i]._soundById(ids[j])
                        if (sound && sound._node && !(sound._node as HowlerAudioElement)._unlocked) {
                            ;(sound._node as HowlerAudioElement)._unlocked = true
                            ;(sound._node as HTMLAudioElement).load()
                        }
                    }
                }
            }

            // Fix Android can not play in suspend state.
            this._autoResume()

            // Create an empty buffer.
            const source = this.ctx!.createBufferSource() as LegacyAudioBufferSourceNode
            source.buffer = this._scratchBuffer
            source.connect(this.ctx!.destination)

            // Play the empty buffer.
            if (typeof source.start === 'undefined') {
                if (source.noteOn) source.noteOn(0)
            } else {
                source.start(0)
            }

            // Calling resume() on a stack initiated by user gesture is what actually unlocks the audio on Android Chrome >= 55.
            if (typeof this.ctx!.resume === 'function') {
                this.ctx!.resume()
            }

            // Setup a timeout to check that we are unlocked on the next event loop.
            source.onended = () => {
                source.disconnect(0)

                // Update the unlocked state and prevent this check from happening again.
                this._audioUnlocked = true

                // Remove the touch start listener.
                const clean = (e: string, fn: any) => document.removeEventListener(e, fn, true)
                clean('touchstart', unlock)
                clean('touchend', unlock)
                clean('click', unlock)
                clean('keydown', unlock)

                // Let all sounds know that audio has been unlocked.
                for (let i = 0; i < this._howls.length; i++) {
                    this._howls[i]._emit('unlock')
                }
            }
        }

        // Setup a touch start listener to attempt an unlock in.
        document.addEventListener('touchstart', unlock, true)
        document.addEventListener('touchend', unlock, true)
        document.addEventListener('click', unlock, true)
        document.addEventListener('keydown', unlock, true)
    }

    /**
     * Get an unlocked HTML5 Audio object from the pool. If none are left,
     * return a new Audio object and throw a warning.
     * @return {Audio} HTML5 Audio object.
     */
    /** @internal */
    public _obtainHtml5Audio(): HowlerAudioElement {
        // Return the next object from the pool if one exists.
        if (this._html5AudioPool.length) {
            return this._html5AudioPool.pop()!
        }

        //.Check if the audio is locked and throw a warning.
        const testPlay = new Audio().play() as PlayReturn
        if (!!testPlay && typeof testPlay.then === 'function') {
            testPlay.catch(() => {
                console.warn('HTML5 Audio pool exhausted, returning potentially locked audio object.')
            })
        }
        return new Audio()
    }

    /**
     * Return an activated HTML5 Audio object to the pool.
     */
    /** @internal */
    public _releaseHtml5Audio(audio: HowlerAudioElement): void {
        // Don't add audio to the pool if we don't know if it has been unlocked.
        if (audio._unlocked) {
            this._html5AudioPool.push(audio)
        }
    }

    /**
     * Automatically suspend the Web Audio AudioContext after no sound has played for 30 seconds.
     * This saves processing/energy and fixes various browser-specific bugs with audio getting stuck.
     */
    /** @internal */
    public _autoSuspendLogic(): void {
        if (!this.autoSuspend || !this.ctx || typeof this.ctx.suspend === 'undefined' || !this.usingWebAudio) {
            return
        }

        // Check if any sounds are playing.
        for (let i = 0; i < this._howls.length; i++) {
            if (this._howls[i]._webAudio) {
                const sounds = this._howls[i]._sounds
                for (let j = 0; j < sounds.length; j++) {
                    if (!sounds[j]._paused) return
                }
            }
        }

        if (this._suspendTimer) clearTimeout(this._suspendTimer)

        // If no sound has played after 30 seconds, suspend the context.
        this._suspendTimer = setTimeout(() => {
            if (!this.autoSuspend) return
            this._suspendTimer = null
            this.state = 'suspending'

            // Handle updating the state of the audio context after suspending.
            const handleSuspension = () => {
                this.state = 'suspended'
                if (this._resumeAfterSuspend) {
                    this._resumeAfterSuspend = false
                    this._autoResume()
                }
            }
            // Either the state gets suspended or it is interrupted.
            // Either way, we need to update the state to suspended.
            this.ctx!.suspend().then(handleSuspension, handleSuspension)
        }, 30000)
    }

    /**
     * Automatically resume the Web Audio AudioContext when a new sound is played.
     */
    /** @internal */
    public _autoResume(): void {
        if (!this.ctx || typeof this.ctx.resume === 'undefined' || !this.usingWebAudio) {
            return
        }

        if (this.state === 'running' && this.ctx.state !== 'interrupted' && this._suspendTimer) {
            clearTimeout(this._suspendTimer)
            this._suspendTimer = null
        } else if (this.state === 'suspended' || (this.state === 'running' && this.ctx.state === 'interrupted')) {
            this.ctx.resume().then(() => {
                this.state = 'running'

                // Emit to all Howls that the audio has resumed.
                for (let i = 0; i < this._howls.length; i++) {
                    this._howls[i]._emit('resume')
                }
            })
            if (this._suspendTimer) {
                clearTimeout(this._suspendTimer)
                this._suspendTimer = null
            }
        } else if (this.state === 'suspending') {
            this._resumeAfterSuspend = true
        }
    }
}

// Setup the global audio controller.
export const Howler = new HowlerGlobal()

/** Group Methods **/
/***************************************************************************/

/**
 * Create an audio group controller.
 * @param {Object} o Passed in properties for this group.
 */
export class Howl {
    /** @internal */ public _autoplay: boolean
    /** @internal */ public _format: string[]
    /** @internal */ public _html5: boolean
    /** @internal */ public _muted: boolean
    /** @internal */ public _loop: boolean
    /** @internal */ public _pool: number
    /** @internal */ public _preload: boolean | 'metadata'
    /** @internal */ public _rate: number
    /** @internal */ public _sprite: SoundSpriteDefinitions
    /** @internal */ public _src: string | string[]
    /** @internal */ public _volume: number
    /** @internal */ public _xhr: { method: string; headers: Record<string, string> | null; withCredentials: boolean }
    /** @internal */ public _duration: number
    /** @internal */ public _state: 'unloaded' | 'loading' | 'loaded'
    /** @internal */ public _sounds: Sound[]
    /** @internal */ public _endTimers: Record<number, any>
    /** @internal */ public _queue: { event?: string; action: () => void }[]
    /** @internal */ public _playLock: boolean
    /** @internal */ public _webAudio: boolean

    /** @internal */ public _events: Record<string, { id?: number; fn: Function; once?: number }[]>

    constructor(options: HowlOptions) {
        // Throw an error if no source is provided.
        if (!options.src || options.src.length === 0) {
            console.error('An array of source files must be passed with any new Howl.')
        }

        /**
         * Initialize a new Howl group object.
         * @param  {Object} o Passed in properties for this group.
         * @return {Howl}
         */
        // If we don't have an AudioContext created yet, run the setup.
        if (!Howler.ctx) Howler._setupAudioContext()

        // Setup user-defined default properties.
        this._events = {}
        this._autoplay = options.autoplay || false
        this._format = typeof options.format !== 'string' ? options.format || [] : [options.format]
        this._html5 = options.html5 || false
        this._muted = options.mute || false
        this._loop = options.loop || false
        this._pool = options.pool || 5
        this._preload = typeof options.preload === 'boolean' || options.preload === 'metadata' ? options.preload : true
        this._rate = options.rate || 1
        this._sprite = options.sprite || {}
        this._src = typeof options.src !== 'string' ? options.src || [] : [options.src]
        this._volume = options.volume !== undefined ? options.volume : 1
        this._xhr = {
            method: options.xhr && options.xhr.method ? options.xhr.method : 'GET',
            headers: options.xhr && options.xhr.headers ? options.xhr.headers : null,
            withCredentials: options.xhr && options.xhr.withCredentials ? options.xhr.withCredentials : false
        }

        // Setup all other default properties.
        this._duration = 0
        this._state = 'unloaded'
        this._sounds = []
        this._endTimers = {}
        this._queue = []
        this._playLock = false

        // Setup event listeners.
        if (options.onend) this.on('end', options.onend)
        if (options.onfade) this.on('fade', options.onfade)
        if (options.onload) this.on('load', options.onload)
        if (options.onloaderror) this.on('loaderror', options.onloaderror)
        if (options.onplayerror) this.on('playerror', options.onplayerror)
        if (options.onpause) this.on('pause', options.onpause)
        if (options.onplay) this.on('play', options.onplay)
        if (options.onstop) this.on('stop', options.onstop)
        if (options.onmute) this.on('mute', options.onmute)
        if (options.onvolume) this.on('volume', options.onvolume)
        if (options.onrate) this.on('rate', options.onrate)
        if (options.onseek) this.on('seek', options.onseek)
        if (options.onunlock) this.on('unlock', options.onunlock)

        // Web Audio or HTML5 Audio?
        this._webAudio = Howler.usingWebAudio && !this._html5

        // Automatically try to enable audio.
        if (typeof Howler.ctx !== 'undefined' && Howler.ctx && Howler.autoUnlock) {
            Howler._unlockAudio()
        }

        // Keep track of this Howl group in the global controller.
        Howler._howls.push(this)

        // If they selected autoplay, add a play event to the load queue.
        if (this._autoplay) {
            this._queue.push({
                event: 'play',
                action: () => {
                    this.play()
                }
            })
        }

        // Load the source file unless otherwise specified.
        if (this._preload) {
            this.load()
        }
    }

    // --- Public Methods ---

    /**
     * Load the audio file.
     * @return {Howler}
     */
    public load(): this {
        let url: string | null = null

        // If no audio is available, quit immediately.
        if (Howler.noAudio) {
            this._emit('loaderror', undefined, 'No audio support.')
            return this
        }

        // Make sure our source is in an array.
        if (typeof this._src === 'string') {
            this._src = [this._src]
        }

        // Loop through the sources and pick the first one that is compatible.
        for (let i = 0; i < this._src.length; i++) {
            let ext: string | null = null
            let str = this._src[i]

            if (this._format && this._format[i]) {
                // If an extension was specified, use that instead.
                ext = this._format[i]
            } else {
                // Make sure the source is a string.
                if (typeof str !== 'string') {
                    this._emit('loaderror', undefined, 'Non-string found in selected audio sources - ignoring.')
                    continue
                }

                // Extract the file extension from the URL or base64 data URI.
                const extMatch = /^data:audio\/([^;,]+);/i.exec(str)
                if (extMatch) {
                    ext = extMatch[1]
                } else {
                    const match = /\.([^.]+)$/.exec(str.split('?', 1)[0])
                    if (match) ext = match[1]
                }

                if (ext) {
                    ext = ext.toLowerCase()
                }
            }

            // Log a warning if no extension was found.
            if (!ext) {
                console.warn(
                    'No file extension was found. Consider using the "format" property or specify an extension.'
                )
            }

            // Check if this extension is available.
            if (ext && Howler.codecs(ext)) {
                url = this._src[i]
                break
            }
        }

        if (!url) {
            this._emit('loaderror', undefined, 'No codec support for selected audio sources.')
            return this
        }

        this._src = url
        this._state = 'loading'

        // If the hosting page is HTTPS and the source isn't,
        // drop down to HTML5 Audio to avoid Mixed Content errors.
        if (window.location.protocol === 'https:' && url.slice(0, 5) === 'http:') {
            this._html5 = true
            this._webAudio = false
        }

        // Create a new sound object and add it to the pool.
        new Sound(this)

        // Load and decode the audio data for playback.
        if (this._webAudio) {
            this._loadBuffer()
        }

        return this
    }

    /**
     * Play a sound or resume previous playback.
     * @param  {String/Number} sprite   Sprite name for sprite playback or sound id to continue previous.
     * @param  {Boolean} internal Internal Use: true prevents event firing.
     * @return {Number}          Sound ID.
     */
    public play(spriteOrId?: string | number): number
    /** @internal */
    public play(id: number, internal: boolean): number
    public play(spriteOrId?: string | number, internalArg?: boolean): number | null {
        const internal = internalArg === true

        let id: number | null = null
        let sprite: string | null = null

        // Determine if a sprite, sound id or nothing was passed
        if (typeof spriteOrId === 'number') {
            id = spriteOrId
            sprite = null
        } else if (typeof spriteOrId === 'string' && this._state === 'loaded' && !this._sprite[spriteOrId]) {
            // If the passed sprite doesn't exist, do nothing.
            return null
        } else if (typeof spriteOrId === 'undefined') {
            // Use the default sound sprite (plays the full audio length).
            sprite = '__default'

            // Check if there is a single paused sound that isn't ended.
            // If there is, play that sound. If not, continue as usual.
            if (!this._playLock) {
                let num = 0
                for (let i = 0; i < this._sounds.length; i++) {
                    if (this._sounds[i]._paused && !this._sounds[i]._ended) {
                        num++
                        id = this._sounds[i]._id
                    }
                }
                if (num === 1) sprite = null
                else id = null
            }
        } else {
            sprite = spriteOrId
        }

        // Get the selected node, or get one from the pool.
        const sound = id ? this._soundById(id) : this._inactiveSound()

        // If the sound doesn't exist, do nothing.
        if (!sound) return null

        // Select the sprite definition.
        if (id && !sprite) {
            sprite = sound._sprite || '__default'
        }

        // If the sound hasn't loaded, we must wait to get the audio's duration.
        // We also need to wait to make sure we don't run into race conditions with
        // the order of function calls.
        if (this._state !== 'loaded') {
            // Set the sprite value on this sound.
            sound._sprite = sprite!

            // Mark this sound as not ended in case another sound is played before this one loads.
            sound._ended = false

            // Add the sound to the queue to be played on load.
            const soundId = sound._id
            this._queue.push({
                event: 'play',
                action: () => {
                    this.play(soundId)
                }
            })
            return soundId
        }

        // Don't play the sound if an id was passed and it is already playing.
        if (id && !sound._paused) {
            // Trigger the play event, in order to keep iterating through queue.
            if (!internal) {
                this._loadQueue('play')
            }
            return sound._id
        }

        // Make sure the AudioContext isn't suspended, and resume it if it is.
        if (this._webAudio) Howler._autoResume()

        // Determine how long to play for and where to start playing.
        const seek = Math.max(0, sound._seek > 0 ? sound._seek : this._sprite[sprite!][0] / 1000)
        const duration = Math.max(0, (this._sprite[sprite!][0] + this._sprite[sprite!][1]) / 1000 - seek)
        const timeout = (duration * 1000) / Math.abs(sound._rate)
        const start = this._sprite[sprite!][0] / 1000
        const stop = (this._sprite[sprite!][0] + this._sprite[sprite!][1]) / 1000
        sound._sprite = sprite!

        // Mark the sound as ended instantly so that this async playback
        // doesn't get grabbed by another call to play while this one waits to start.
        sound._ended = false

        // Update the parameters of the sound.
        const setParams = () => {
            sound._paused = false
            sound._seek = seek
            sound._start = start
            sound._stop = stop
            sound._loop = !!(sound._loop || this._sprite[sprite!][2])
        }

        // End the sound instantly if seek is at the end.
        if (seek >= stop) {
            this._ended(sound)
            return sound._id
        }

        // Begin the actual playback.
        const node = sound._node!

        if (this._webAudio) {
            // Fire this when the sound is ready to play to begin Web Audio playback.
            const playWebAudio = () => {
                this._playLock = false
                setParams()
                this._refreshBuffer(sound)

                // Setup the playback params.
                const vol = sound._muted || this._muted ? 0 : sound._volume
                ;(node as GainNode).gain.setValueAtTime(vol, Howler.ctx!.currentTime)
                sound._playStart = Howler.ctx!.currentTime

                // Play the sound using the supported method.
                const bufferSource = (node as HowlerGainNode).bufferSource!
                if (typeof bufferSource.start === 'undefined') {
                    if (sound._loop) {
                        if (bufferSource.noteGrainOn) bufferSource.noteGrainOn(0, seek, 86400)
                    } else {
                        if (bufferSource.noteGrainOn) bufferSource.noteGrainOn(0, seek, duration)
                    }
                } else {
                    sound._loop ? bufferSource.start(0, seek, 86400) : bufferSource.start(0, seek, duration)
                }

                // Start a new timer if none is present.
                if (timeout !== Infinity) {
                    this._endTimers[sound._id] = setTimeout(this._ended.bind(this, sound), timeout)
                }

                if (!internal) {
                    setTimeout(() => {
                        this._emit('play', sound._id)
                        this._loadQueue()
                    }, 0)
                }
            }

            if (Howler.state === 'running' && Howler.ctx!.state !== 'interrupted') {
                playWebAudio()
            } else {
                this._playLock = true

                // Wait for the audio context to resume before playing.
                this.once('resume', playWebAudio)

                // Cancel the end timer.
                this._clearTimer(sound._id)
            }
        } else {
            // Fire this when the sound is ready to play to begin HTML5 Audio playback.
            const html5Node = node as HowlerAudioElement
            const playHtml5 = () => {
                html5Node.currentTime = seek
                html5Node.muted = sound._muted || this._muted || Howler._muted || html5Node.muted
                html5Node.volume = sound._volume * Howler.volume()
                html5Node.playbackRate = sound._rate

                // Some browsers will throw an error if this is called without user interaction.
                try {
                    const play = html5Node.play() as PlayReturn

                    // Support older browsers that don't support promises, and thus don't have this issue.
                    if (!!play && typeof play.then === 'function') {
                        // Implements a lock to prevent DOMException: The play() request was interrupted by a call to pause().
                        this._playLock = true

                        // Set param values immediately.
                        setParams()

                        // Releases the lock and executes queued actions.
                        play.then(() => {
                            this._playLock = false
                            html5Node._unlocked = true
                            if (!internal) {
                                this._emit('play', sound._id)
                            } else {
                                this._loadQueue()
                            }
                        }).catch(() => {
                            this._playLock = false
                            this._emit('playerror', sound._id, 'Playback was unable to start.')

                            // Reset the ended and paused values.
                            sound._ended = true
                            sound._paused = true
                        })
                    } else if (!internal) {
                        this._playLock = false
                        setParams()
                        this._emit('play', sound._id)
                    }

                    // Setting rate before playing won't work in IE, so we set it again here.
                    html5Node.playbackRate = sound._rate

                    // If the node is still paused, then we can assume there was a playback issue.
                    if (html5Node.paused) {
                        this._emit('playerror', sound._id, 'Playback was unable to start.')
                        return
                    }

                    // Setup the end timer on sprites or listen for the ended event.
                    if (sprite !== '__default' || sound._loop) {
                        this._endTimers[sound._id] = setTimeout(this._ended.bind(this, sound), timeout)
                    } else {
                        this._endTimers[sound._id] = () => {
                            // Fire ended on this audio node.
                            this._ended(sound)

                            // Clear this listener.
                            html5Node.removeEventListener('ended', this._endTimers[sound._id], false)
                        }
                        html5Node.addEventListener('ended', this._endTimers[sound._id], false)
                    }
                } catch (err) {
                    this._emit('playerror', sound._id, err)
                }
            }

            // If this is streaming audio, make sure the src is set and load again.
            if (
                html5Node.src ===
                'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
            ) {
                html5Node.src = this._src as string
                html5Node.load()
            }

            // Play immediately if ready, or wait for the 'canplaythrough'e vent.
            const loadedNoReadyState =
                (window && (window as any).ejecta) || (!html5Node.readyState && Howler._navigator.isCocoonJS)
            if (html5Node.readyState >= 3 || loadedNoReadyState) {
                playHtml5()
            } else {
                this._playLock = true
                this._state = 'loading'

                const listener = () => {
                    this._state = 'loaded'

                    // Begin playback.
                    playHtml5()

                    // Clear this listener.
                    html5Node.removeEventListener(Howler._canPlayEvent, listener, false)
                }
                html5Node.addEventListener(Howler._canPlayEvent, listener, false)

                // Cancel the end timer.
                this._clearTimer(sound._id)
            }
        }

        return sound._id
    }

    /**
     * Pause playback and save current position.
     * @param  {Number} id The sound ID (empty to pause all in group).
     * @return {Howl}
     */
    public pause(id?: number): this
    /** @internal */
    public pause(id: number, internal: boolean): this
    public pause(id?: number, internalArg?: boolean): this {
        // If the sound hasn't loaded or a play() promise is pending, add it to the load queue to pause when capable.
        if (this._state !== 'loaded' || this._playLock) {
            this._queue.push({
                event: 'pause',
                action: () => {
                    this.pause(id)
                }
            })
            return this
        }

        // If no id is passed, get all ID's to be paused.
        const ids = this._getSoundIds(id)

        for (let i = 0; i < ids.length; i++) {
            // Clear the end timer.
            this._clearTimer(ids[i])

            // Get the sound.
            const sound = this._soundById(ids[i])

            if (sound && !sound._paused) {
                // Reset the seek position.
                sound._seek = this.seek(ids[i])
                sound._rateSeek = 0
                sound._paused = true

                // Stop currently running fades.
                this._stopFade(ids[i])

                if (sound._node) {
                    if (this._webAudio) {
                        // Make sure the sound has been created.
                        if (!(sound._node as HowlerGainNode).bufferSource) continue

                        const bs = (sound._node as HowlerGainNode).bufferSource!
                        if (typeof bs.stop === 'undefined') {
                            if (bs.noteOff) bs.noteOff(0)
                        } else bs.stop(0)

                        // Clean up the buffer source.
                        this._cleanBuffer(sound._node as GainNode)
                    } else if (
                        !isNaN((sound._node as HTMLAudioElement).duration) ||
                        (sound._node as HTMLAudioElement).duration === Infinity
                    ) {
                        ;(sound._node as HTMLAudioElement).pause()
                    }
                }
            }

            // Fire the pause event, unless `true` is passed as the 2nd argument.
            if (!internalArg) this._emit('pause', sound ? sound._id : undefined)
        }
        return this
    }

    /**
     * Stop playback and reset to start.
     * @param  {Number} id The sound ID (empty to stop all in group).
     * @param  {Boolean} internal Internal Use: true prevents event firing.
     * @return {Howl}
     */
    public stop(id?: number): this
    /** @internal */
    public stop(id: number, internal: boolean): this
    public stop(id?: number, internalArg?: boolean): this {
        const internal = internalArg === true

        // If the sound hasn't loaded, add it to the load queue to stop when capable.
        if (this._state !== 'loaded' || this._playLock) {
            this._queue.push({
                event: 'stop',
                action: () => {
                    this.stop(id)
                }
            })
            return this
        }

        // If no id is passed, get all ID's to be stopped.
        const ids = this._getSoundIds(id)

        for (let i = 0; i < ids.length; i++) {
            // Clear the end timer.
            this._clearTimer(ids[i])

            // Get the sound.
            const sound = this._soundById(ids[i])

            if (sound) {
                // Reset the seek position.
                sound._seek = sound._start || 0
                sound._rateSeek = 0
                sound._paused = true
                sound._ended = true

                // Stop currently running fades.
                this._stopFade(ids[i])

                if (sound._node) {
                    if (this._webAudio) {
                        // Make sure the sound's AudioBufferSourceNode has been created.
                        if ((sound._node as HowlerGainNode).bufferSource) {
                            const bs = (sound._node as HowlerGainNode).bufferSource!
                            if (typeof bs.stop === 'undefined') {
                                if (bs.noteOff) bs.noteOff(0)
                            } else bs.stop(0)

                            // Clean up the buffer source.
                            this._cleanBuffer(sound._node as GainNode)
                        }
                    } else if (
                        !isNaN((sound._node as HTMLAudioElement).duration) ||
                        (sound._node as HTMLAudioElement).duration === Infinity
                    ) {
                        ;(sound._node as HTMLAudioElement).currentTime = sound._start || 0
                        ;(sound._node as HTMLAudioElement).pause()

                        // If this is a live stream, stop download once the audio is stopped.
                        if ((sound._node as HTMLAudioElement).duration === Infinity) {
                            this._clearSound(sound._node as HTMLAudioElement)
                        }
                    }
                }

                if (!internal) this._emit('stop', sound._id)
            }
        }
        return this
    }

    /**
     * Mute/unmute a single sound or all sounds in this Howl group.
     * @param  {Boolean} muted Set to true to mute and false to unmute.
     * @param  {Number} id    The sound ID to update (omit to mute/unmute all).
     * @return {Howl}
     */
    public mute(): boolean
    public mute(muted: boolean, id?: number): this
    public mute(muted?: boolean, id?: number): this | boolean {
        // If the sound hasn't loaded, add it to the load queue to mute when capable.
        if (this._state !== 'loaded' || this._playLock) {
            this._queue.push({
                event: 'mute',
                action: () => {
                    this.mute(muted!, id)
                }
            })
            return this
        }

        // If applying mute/unmute to all sounds, update the group's value.
        if (typeof id === 'undefined') {
            if (typeof muted === 'boolean') {
                this._muted = muted
            } else {
                return this._muted
            }
        }

        // If no id is passed, get all ID's to be muted.
        const ids = this._getSoundIds(id)
        for (let i = 0; i < ids.length; i++) {
            const sound = this._soundById(ids[i])
            if (sound) {
                sound._muted = muted!

                // Cancel active fade and set the volume to the end value.
                if (sound._interval) this._stopFade(sound._id)

                if (this._webAudio && sound._node) {
                    ;(sound._node as GainNode).gain.setValueAtTime(muted ? 0 : sound._volume, Howler.ctx!.currentTime)
                } else if (sound._node) {
                    ;(sound._node as HTMLAudioElement).muted = Howler._muted ? true : muted!
                }
                this._emit('mute', sound._id)
            }
        }
        return this
    }

    /**
     * Get/set the volume of this sound or of the Howl group. This method can optionally take 0, 1 or 2 arguments.
     *   volume() -> Returns the group's volume value.
     *   volume(id) -> Returns the sound id's current volume.
     *   volume(vol) -> Sets the volume of all sounds in this Howl group.
     *   volume(vol, id) -> Sets the volume of passed sound id.
     * @return {Howl/Number} Returns self or current volume.
     */
    public volume(): number
    public volume(idOrSetVolume: number): this | number
    public volume(volume: number, id: number): this
    /** @internal */
    public volume(volume: number, id: number, internal: boolean): this
    public volume(vol?: number, id?: number, internalArg?: boolean): this | number {
        let _vol = vol
        let _id = id

        // Determine argument types based on length/types
        if (typeof vol === 'undefined') {
            // Return the value of the groups' volume.
            return this._volume
        } else if (typeof id === 'undefined' && typeof vol === 'number') {
            // First check if this is an ID, and if not, assume it is a new volume.
            const ids = this._getSoundIds()
            const index = ids.indexOf(vol)
            if (index >= 0) {
                // volume(id) -> Getter
                _id = vol
                _vol = undefined
            } else {
                // volume(vol) -> Setter
                _vol = vol
                _id = undefined
            }
        }

        // Update the volume or return the current volume.
        if (typeof _vol !== 'undefined' && _vol >= 0 && _vol <= 1) {
            // If the sound hasn't loaded, add it to the load queue to change volume when capable.
            if (this._state !== 'loaded' || this._playLock) {
                this._queue.push({
                    event: 'volume',
                    action: () => {
                        this.volume(_vol!, _id!)
                    }
                })
                return this
            }

            // Set the group volume.
            if (typeof _id === 'undefined') {
                this._volume = _vol
            }

            // Update one or all volumes.
            const ids = this._getSoundIds(_id)
            for (let i = 0; i < ids.length; i++) {
                const sound = this._soundById(ids[i])
                if (sound) {
                    sound._volume = _vol

                    // Stop currently running fades.
                    if (!internalArg) this._stopFade(ids[i])

                    if (this._webAudio && sound._node && !sound._muted) {
                        ;(sound._node as GainNode).gain.setValueAtTime(_vol, Howler.ctx!.currentTime)
                    } else if (sound._node && !sound._muted) {
                        ;(sound._node as HTMLAudioElement).volume = _vol * Howler.volume()
                    }
                    this._emit('volume', sound._id)
                }
            }
            return this
        } else {
            const sound = _id ? this._soundById(_id) : this._sounds[0]
            return sound ? sound._volume : 0
        }
    }

    /**
     * Fade a currently playing sound between two volumes (if no id is passed, all sounds will fade).
     * @param  {Number} from The value to fade from (0.0 to 1.0).
     * @param  {Number} to   The volume to fade to (0.0 to 1.0).
     * @param  {Number} len  Time in milliseconds to fade.
     * @param  {Number} id   The sound id (omit to fade all sounds).
     * @return {Howl}
     */
    public fade(from: number, to: number, duration: number, id?: number): this {
        // If the sound hasn't loaded, add it to the load queue to fade when capable.
        if (this._state !== 'loaded' || this._playLock) {
            this._queue.push({
                event: 'fade',
                action: () => {
                    this.fade(from, to, duration, id)
                }
            })
            return this
        }

        // Make sure the to/from/len values are numbers.
        from = Math.min(Math.max(0, from), 1)
        to = Math.min(Math.max(0, to), 1)

        // Set the volume to the start position.
        this.volume(from, id!)

        // Fade the volume of one or all sounds.
        const ids = this._getSoundIds(id)
        for (let i = 0; i < ids.length; i++) {
            const sound = this._soundById(ids[i])
            if (sound) {
                // Stop the previous fade if no sprite is being used (otherwise, volume handles this).
                if (!id) this._stopFade(ids[i])

                // If we are using Web Audio, let the native methods do the actual fade.
                if (this._webAudio && !sound._muted) {
                    const currentTime = Howler.ctx!.currentTime
                    const end = currentTime + duration / 1000
                    sound._volume = from
                    ;(sound._node as GainNode).gain.setValueAtTime(from, currentTime)
                    ;(sound._node as GainNode).gain.linearRampToValueAtTime(to, end)
                }
                this._startFadeInterval(sound, from, to, duration, typeof id === 'undefined')
            }
        }
        return this
    }

    /**
     * Get/set the loop parameter on a sound. This method can optionally take 0, 1 or 2 arguments.
     *   loop() -> Returns the group's loop value.
     *   loop(id) -> Returns the sound id's loop value.
     *   loop(loop) -> Sets the loop value for all sounds in this Howl group.
     *   loop(loop, id) -> Sets the loop value of passed sound id.
     * @return {Howl/Boolean} Returns self or current loop value.
     */
    public loop(id?: number): boolean
    public loop(loop: boolean, id?: number): this
    public loop(loop?: boolean | number, id?: number): boolean | this {
        // Determine the values for loop and id.
        if (typeof loop === 'undefined') {
            return this._loop
        }

        if (typeof loop === 'boolean') {
            if (typeof id === 'undefined') {
                this._loop = loop
            }

            // If no id is passed, get all ID's to be looped.
            const ids = this._getSoundIds(id)
            for (let i = 0; i < ids.length; i++) {
                const sound = this._soundById(ids[i])
                if (sound) {
                    sound._loop = loop
                    if (this._webAudio && sound._node && (sound._node as HowlerGainNode).bufferSource) {
                        const bs = (sound._node as HowlerGainNode).bufferSource!
                        bs.loop = loop
                        if (loop) {
                            bs.loopStart = sound._start || 0
                            bs.loopEnd = sound._stop

                            // If playing, restart playback to ensure looping updates.
                            if (this.playing(ids[i])) {
                                this.pause(ids[i])
                                this.play(ids[i], true)
                            }
                        }
                    }
                }
            }
            return this
        }

        // Return this sound's loop value.
        const sound = this._soundById(loop)
        return sound ? sound._loop : false
    }

    /**
     * Get/set the playback rate of a sound. This method can optionally take 0, 1 or 2 arguments.
     *   rate() -> Returns the first sound node's current playback rate.
     *   rate(id) -> Returns the sound id's current playback rate.
     *   rate(rate) -> Sets the playback rate of all sounds in this Howl group.
     *   rate(rate, id) -> Sets the playback rate of passed sound id.
     * @return {Howl/Number} Returns self or the current playback rate.
     */
    public rate(id?: number): number
    public rate(rate: number, id?: number): this
    public rate(rate?: number, id?: number): this | number {
        // Determine the values based on arguments.
        if (typeof rate === 'undefined') {
            return this._sounds[0] ? this._sounds[0]._rate : this._rate
        }

        if (typeof rate === 'number') {
            // If the sound hasn't loaded, add it to the load queue to change playback rate when capable.
            if (this._state !== 'loaded' || this._playLock) {
                this._queue.push({
                    event: 'rate',
                    action: () => {
                        this.rate(rate, id)
                    }
                })
                return this
            }

            if (typeof id === 'undefined') {
                this._rate = rate
            }

            // Update one or all volumes.
            const ids = this._getSoundIds(id)
            for (let i = 0; i < ids.length; i++) {
                const sound = this._soundById(ids[i])
                if (sound) {
                    // Keep track of our position when the rate changed and update the playback
                    // start position so we can properly adjust the seek position for time elapsed.
                    if (this.playing(ids[i])) {
                        sound._rateSeek = this.seek(ids[i])
                        sound._playStart = this._webAudio ? Howler.ctx!.currentTime : sound._playStart
                    }
                    sound._rate = rate

                    // Change the playback rate.
                    if (this._webAudio && sound._node && (sound._node as HowlerGainNode).bufferSource) {
                        ;(sound._node as HowlerGainNode).bufferSource!.playbackRate.setValueAtTime(
                            rate,
                            Howler.ctx!.currentTime
                        )
                    } else if (sound._node) {
                        ;(sound._node as HTMLAudioElement).playbackRate = rate
                    }

                    // Reset the timers.
                    const seek = this.seek(ids[i])
                    const duration = (this._sprite[sound._sprite][0] + this._sprite[sound._sprite][1]) / 1000 - seek
                    const timeout = (duration * 1000) / Math.abs(sound._rate)

                    // Start a new end timer if sound is already playing.
                    if (this._endTimers[ids[i]] || !sound._paused) {
                        this._clearTimer(ids[i])
                        this._endTimers[ids[i]] = setTimeout(this._ended.bind(this, sound), timeout)
                    }
                    this._emit('rate', sound._id)
                }
            }
            return this
        } else {
            const sound = this._soundById(rate!)
            return sound ? sound._rate : this._rate
        }
    }

    /**
     * Get/set the seek position of a sound. This method can optionally take 0, 1 or 2 arguments.
     *   seek() -> Returns the first sound node's current seek position.
     *   seek(id) -> Returns the sound id's current seek position.
     *   seek(seek) -> Sets the seek position of the first sound node.
     *   seek(seek, id) -> Sets the seek position of passed sound id.
     * @return {Howl/Number} Returns self or the current seek position.
     */
    public seek(id?: number): number
    public seek(seek: number, id?: number): this
    public seek(seek?: number, id?: number): this | number {
        // Determine the values based on arguments.
        if (typeof seek === 'undefined') {
            if (this._sounds.length) return this._sounds[0]._seek
            return 0
        }

        // If the sound hasn't loaded, add it to the load queue to seek when capable.
        if (typeof seek === 'number' && (this._state !== 'loaded' || this._playLock)) {
            this._queue.push({
                event: 'seek',
                action: () => {
                    this.seek(seek, id)
                }
            })
            return this
        }

        // First check if this is an ID, and if not, assume it is a new seek position.
        if (typeof seek !== 'number' || (arguments.length === 1 && this._getSoundIds().indexOf(seek) >= 0)) {
            const sound = this._soundById(seek)
            if (sound) {
                if (this._webAudio) {
                    const realTime = this.playing(seek) ? Howler.ctx!.currentTime - sound._playStart : 0
                    const rateSeek = sound._rateSeek ? sound._rateSeek - sound._seek : 0
                    return sound._seek + (rateSeek + realTime * Math.abs(sound._rate))
                } else {
                    return (sound._node as HTMLAudioElement).currentTime
                }
            }
            return 0
        }

        // If there is no ID, bail out.
        const targetId = typeof id === 'undefined' ? (this._sounds.length ? this._sounds[0]._id : undefined) : id
        if (typeof targetId === 'undefined') return this

        // Get the sound.
        const sound = this._soundById(targetId)
        if (sound) {
            if (seek >= 0) {
                // Pause the sound and update position for restarting playback.
                const playing = this.playing(targetId)
                if (playing) this.pause(targetId, true)

                // Move the position of the track and cancel timer.
                sound._seek = seek
                sound._ended = false
                this._clearTimer(targetId)

                // Update the seek position for HTML5 Audio.
                if (!this._webAudio && sound._node && !isNaN((sound._node as HTMLAudioElement).duration)) {
                    ;(sound._node as HTMLAudioElement).currentTime = seek
                }

                // Seek and emit when ready.
                const seekAndEmit = () => {
                    // Restart the playback if the sound was playing.
                    if (playing) this.play(targetId, true)
                    this._emit('seek', targetId)
                }

                // Wait for the play lock to be unset before emitting (HTML5 Audio).
                if (playing && !this._webAudio) {
                    const emitSeek = () => {
                        if (!this._playLock) seekAndEmit()
                        else setTimeout(emitSeek, 0)
                    }
                    setTimeout(emitSeek, 0)
                } else {
                    seekAndEmit()
                }
            }
        }
        return this
    }

    /**
     * Check if a specific sound is currently playing or not (if id is provided), or check if at least one of the sounds in the group is playing or not.
     * @param  {Number}  id The sound id to check. If none is passed, the whole sound group is checked.
     * @return {Boolean} True if playing and false if not.
     */
    public playing(id?: number): boolean {
        // Check the passed sound ID (if any).
        if (typeof id === 'number') {
            const sound = this._soundById(id)
            return sound ? !sound._paused : false
        }

        // Otherwise, loop through all sounds and check if any are playing.
        for (let i = 0; i < this._sounds.length; i++) {
            if (!this._sounds[i]._paused) return true
        }
        return false
    }

    /**
     * Get the duration of this sound. Passing a sound id will return the sprite duration.
     * @param  {Number} id The sound id to check. If none is passed, return full source duration.
     * @return {Number} Audio duration in seconds.
     */
    public duration(id?: number): number {
        let duration = this._duration
        const sound = this._soundById(id!)
        if (sound) {
            duration = this._sprite[sound._sprite][1] / 1000
        }
        return duration
    }

    /**
     * Returns the current loaded state of this Howl.
     * @return {String} 'unloaded', 'loading', 'loaded'
     */
    public state(): 'unloaded' | 'loading' | 'loaded' {
        return this._state
    }

    /**
     * Unload and destroy the current Howl object.
     * This will immediately stop all sound instances attached to this group.
     */
    public unload(): null {
        // Stop playing any active sounds.
        for (let i = 0; i < this._sounds.length; i++) {
            // Stop the sound if it is currently playing.
            if (!this._sounds[i]._paused) this.stop(this._sounds[i]._id)

            // Remove the source or disconnect.
            if (!this._webAudio) {
                // Set the source to 0-second silence to stop any downloading (except in IE).
                this._clearSound(this._sounds[i]._node as HTMLAudioElement)

                // Remove any event listeners.
                ;(this._sounds[i]._node as HTMLAudioElement).removeEventListener(
                    'error',
                    this._sounds[i]._errorFn!,
                    false
                )
                ;(this._sounds[i]._node as HTMLAudioElement).removeEventListener(
                    Howler._canPlayEvent,
                    this._sounds[i]._loadFn!,
                    false
                )
                ;(this._sounds[i]._node as HTMLAudioElement).removeEventListener(
                    'ended',
                    this._sounds[i]._endFn!,
                    false
                )

                // Release the Audio object back to the pool.
                Howler._releaseHtml5Audio(this._sounds[i]._node as HowlerAudioElement)
            }

            // Empty out all of the nodes.
            delete (this._sounds[i] as any)._node

            // Make sure all timers are cleared out.
            this._clearTimer(this._sounds[i]._id)
        }

        // Remove the references in the global Howler object.
        const index = Howler._howls.indexOf(this)
        if (index >= 0) Howler._howls.splice(index, 1)

        // Delete this sound from the cache (if no other Howl is using it).
        if (bufferCache && bufferCache[this._src as string]) {
            delete bufferCache[this._src as string]
        }

        // Clear out `self`.
        this._state = 'unloaded'
        this._sounds = []
        return null
    }

    // --- Event System ---

    /**
     * Listen to a custom event.
     * @param  {String}   event Event name.
     * @param  {Function} fn    Listener to call.
     * @param  {Number}   id    (optional) Only listen to events for this sound.
     * @param  {Number}   once  (INTERNAL) Marks event to fire only once.
     * @return {Howl}
     */
    public on(event: 'load', callback: () => void, id?: number): this
    public on(event: 'loaderror' | 'playerror', callback: HowlErrorCallback, id?: number): this
    public on(event: string, callback: HowlCallback, id?: number): this
    /** @internal */
    public on(event: string, fn: Function, id: number | undefined, once: number): this
    public on(event: string, fn: Function, id?: number, once?: number): this {
        if (!this._events[event]) this._events[event] = []
        this._events[event].push(once ? { id, fn, once } : { id, fn })
        return this
    }

    /**
     * Listen to a custom event and remove it once fired.
     * @param  {String}   event Event name.
     * @param  {Function} fn    Listener to call.
     * @param  {Number}   id    (optional) Only listen to events for this sound.
     * @return {Howl}
     */
    public once(event: 'load', callback: () => void, id?: number): this
    public once(event: 'loaderror' | 'playerror', callback: HowlErrorCallback, id?: number): this
    public once(event: string, callback: HowlCallback, id?: number): this
    public once(event: string, fn: Function, id?: number): this {
        return this.on(event, fn, id, 1)
    }

    /**
     * Remove a custom event. Call without parameters to remove all events.
     * @param  {String}   event Event name.
     * @param  {Function} fn    Listener to remove. Leave empty to remove all.
     * @param  {Number}   id    (optional) Only remove events for this sound.
     * @return {Howl}
     */
    public off(event: 'load', callback?: () => void, id?: number): this
    public off(event: 'loaderror' | 'playerror', callback?: HowlErrorCallback, id?: number): this
    public off(event: string, callback?: HowlCallback, id?: number): this
    /** @internal */
    public off(event: string, fn?: Function, id?: number): this
    public off(event: string, fn?: Function, id?: number): this {
        let _id = id
        let _fn = fn

        // Allow passing just an event and ID.
        if (typeof fn === 'number') {
            _id = fn
            _fn = undefined
        }

        if (this._events[event]) {
            for (let i = 0; i < this._events[event].length; i++) {
                if (_fn && (this._events[event][i].fn === _fn || (_id && this._events[event][i].id === _id))) {
                    this._events[event].splice(i, 1)
                    break
                } else if (!_fn && _id) {
                    if (this._events[event][i].id === _id) {
                        this._events[event].splice(i, 1)
                    }
                } else if (!_fn && !_id) {
                    this._events[event] = []
                    break
                }
            }
        }
        return this
    }

    // --- Internal Helpers ---

    /**
     * Emit all events of a specific type and pass the sound id.
     * @param  {String} event Event name.
     * @param  {Number} id    Sound ID.
     * @param  {Number} msg   Message to go with event.
     */
    /** @internal */
    public _emit(event: string, id?: number, msg?: any): void {
        if (this._events[event]) {
            // Loop through event store and fire all functions.
            for (let i = this._events[event].length - 1; i >= 0; i--) {
                // Only fire the listener if the correct ID is used.
                if (!this._events[event][i].id || this._events[event][i].id === id || event === 'load') {
                    const fn = this._events[event][i].fn
                    setTimeout(() => fn.call(this, id, msg), 0)

                    // If this event was setup with `once`, remove it.
                    if (this._events[event][i].once) this.off(event, fn, this._events[event][i].id)
                }
            }
        }

        // Pass the event type into load queue so that it can continue stepping.
        this._loadQueue(event)
    }

    /**
     * Queue of actions initiated before the sound has loaded.
     * These will be called in sequence, with the next only firing
     * after the previous has finished executing (even if async like play).
     */
    /** @internal */
    public _loadQueue(event?: string): void {
        if (this._queue.length > 0) {
            const task = this._queue[0]

            // Remove this task if a matching event was passed.
            if (task.event === event) {
                this._queue.shift()
                this._loadQueue()
            }

            // Run the task if no event type is passed.
            if (!event) {
                task.action()
            }
        }
    }

    /**
     * Fired when playback ends at the end of the duration.
     * @param  {Sound} sound The sound object to work with.
     */
    /** @internal */
    public _ended(sound: Sound): void {
        const sprite = sound._sprite

        // If we are using IE and there was network latency we may be clipping
        // audio before it completes playing. Lets check the node to make sure it
        // believes it has completed, before ending the playback.
        if (
            !this._webAudio &&
            sound._node &&
            (sound._node as HowlerAudioElement).paused &&
            !(sound._node as HTMLAudioElement).ended &&
            (sound._node as HTMLAudioElement).currentTime < sound._stop
        ) {
            setTimeout(this._ended.bind(this, sound), 100)
        }

        // Should this sound loop?
        const loop = !!(sound._loop || this._sprite[sprite][2])

        // Fire the ended event.
        this._emit('end', sound._id)

        // Restart the playback for HTML5 Audio loop.
        if (!this._webAudio && loop) {
            this.stop(sound._id, true)
            this.play(sound._id)
        }

        // Restart this timer if on a Web Audio loop.
        if (this._webAudio && loop) {
            this._emit('play', sound._id)
            sound._seek = sound._start || 0
            sound._rateSeek = 0
            sound._playStart = Howler.ctx!.currentTime

            const timeout = ((sound._stop - sound._start) * 1000) / Math.abs(sound._rate)
            this._endTimers[sound._id] = setTimeout(this._ended.bind(this, sound), timeout)
        }

        // Mark the node as paused.
        if (this._webAudio && !loop) {
            sound._paused = true
            sound._ended = true
            sound._seek = sound._start || 0
            sound._rateSeek = 0
            this._clearTimer(sound._id)

            // Clean up the buffer source.
            this._cleanBuffer(sound._node as GainNode)

            // Attempt to auto-suspend AudioContext if no sounds are still playing.
            Howler._autoSuspendLogic()
        }

        // When using a sprite, end the track.
        if (!this._webAudio && !loop) {
            this.stop(sound._id, true)
        }
    }

    /**
     * Clear the end timer for a sound playback.
     * @param  {Number} id The sound ID.
     */
    /** @internal */
    public _clearTimer(id: number): void {
        if (this._endTimers[id]) {
            // Clear the timeout or remove the ended listener.
            if (typeof this._endTimers[id] !== 'function') {
                clearTimeout(this._endTimers[id])
            } else {
                const sound = this._soundById(id)
                if (sound && sound._node) {
                    ;(sound._node as HTMLAudioElement).removeEventListener('ended', this._endTimers[id], false)
                }
            }
            delete this._endTimers[id]
        }
    }

    /**
     * Return the sound identified by this ID, or return null.
     * @param  {Number} id Sound ID
     * @return {Object}    Sound object or null.
     */
    /** @internal */
    public _soundById(id: number): Sound | null {
        // Loop through all sounds and find the one with this ID.
        for (let i = 0; i < this._sounds.length; i++) {
            if (id === this._sounds[i]._id) return this._sounds[i]
        }
        return null
    }

    /**
     * Return an inactive sound from the pool or create a new one.
     * @return {Sound} Sound playback object.
     */
    /** @internal */
    public _inactiveSound(): Sound {
        this._drain()

        // Find the first inactive node to recycle.
        for (let i = 0; i < this._sounds.length; i++) {
            if (this._sounds[i]._ended) return this._sounds[i].reset()
        }

        // If no inactive node was found, create a new one.
        return new Sound(this)
    }

    /**
     * Drain excess inactive sounds from the pool.
     */
    /** @internal */
    public _drain() {
        const limit = this._pool
        let cnt = 0

        // If there are less sounds than the max pool size, we are done.
        if (this._sounds.length < limit) return

        // Count the number of inactive sounds.
        for (let i = 0; i < this._sounds.length; i++) {
            if (this._sounds[i]._ended) cnt++
        }

        // Remove excess inactive sounds, going in reverse order.
        for (let i = this._sounds.length - 1; i >= 0; i--) {
            if (cnt <= limit) return
            if (this._sounds[i]._ended) {
                // Disconnect the audio source when using Web Audio.
                if (this._webAudio && this._sounds[i]._node) {
                    ;(this._sounds[i]._node as GainNode).disconnect(0)
                }

                // Remove sounds until we have the pool size.
                this._sounds.splice(i, 1)
                cnt--
            }
        }
    }

    /**
     * Get all ID's from the sounds pool.
     * @param  {Number} id Only return one ID if one is passed.
     * @return {Array}    Array of IDs.
     */
    /** @internal */
    public _getSoundIds(id?: number): number[] {
        if (typeof id === 'undefined') {
            const ids = []
            for (let i = 0; i < this._sounds.length; i++) ids.push(this._sounds[i]._id)
            return ids
        } else {
            return [id]
        }
    }

    /**
     * Load the sound back into the buffer source.
     * @param  {Sound} sound The sound object to work with.
     */
    /** @internal */
    public _refreshBuffer(sound: Sound): void {
        sound._node = sound._node!
        const gn = sound._node as HowlerGainNode

        // Setup the buffer source for playback.
        gn.bufferSource = Howler.ctx!.createBufferSource()
        gn.bufferSource!.buffer = bufferCache[this._src as string]

        // Connect to the correct node.
        gn.bufferSource!.connect(gn as AudioNode)

        // Setup looping and playback rate.
        gn.bufferSource!.loop = sound._loop
        if (sound._loop) {
            gn.bufferSource!.loopStart = sound._start || 0
            gn.bufferSource!.loopEnd = sound._stop || 0
        }
        gn.bufferSource!.playbackRate.setValueAtTime(sound._rate, Howler.ctx!.currentTime)
    }

    /**
     * Prevent memory leaks by cleaning up the buffer source after playback.
     * @param  {Object} node Sound's audio node containing the buffer source.
     */
    /** @internal */
    public _cleanBuffer(node: GainNode): void {
        const gn = node as HowlerGainNode
        if (Howler._scratchBuffer && gn.bufferSource) {
            gn.bufferSource!.onended = null
            gn.bufferSource!.disconnect(0)
            if (Howler._navigator?.vendor.indexOf('Apple') >= 0) {
                try {
                    gn.bufferSource!.buffer = Howler._scratchBuffer!
                } catch (e) {}
            }
        }
        gn.bufferSource = undefined
    }

    /**
     * Set the source to a 0-second silence to stop any downloading (except in IE).
     * @param  {Object} node Audio node to clear.
     */
    /** @internal */
    public _clearSound(node: HTMLAudioElement): void {
        const checkIE = /MSIE |Trident\//.test(Howler._navigator && Howler._navigator.userAgent)
        if (!checkIE) {
            node.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA'
        }
    }

    /**
     * Starts the internal interval to fade a sound.
     * @param  {Object} sound Reference to sound to fade.
     * @param  {Number} from The value to fade from (0.0 to 1.0).
     * @param  {Number} to   The volume to fade to (0.0 to 1.0).
     * @param  {Number} len  Time in milliseconds to fade.
     * @param  {Boolean} isGroup   If true, set the volume on the group.
     */
    /** @internal */
    public _startFadeInterval(sound: Sound, from: number, to: number, len: number, isGroup: boolean): void {
        let vol = from
        const diff = to - from
        const steps = Math.abs(diff / 0.01)
        const stepLen = Math.max(4, steps > 0 ? len / steps : len)
        let lastTick = Date.now()

        // Store the value being faded to.
        sound._fadeTo = to

        // Update the volume value on each interval tick.
        sound._interval = setInterval(() => {
            // Update the volume based on the time since the last tick.
            const tick = (Date.now() - lastTick) / len
            lastTick = Date.now()
            vol += diff * tick

            // Round to within 2 decimal points.
            vol = Math.round(vol * 100) / 100

            // Make sure the volume is in the right bounds.
            if (diff < 0) vol = Math.max(to, vol)
            else vol = Math.min(to, vol)

            // Change the volume.
            if (this._webAudio) {
                sound._volume = vol
            } else {
                this.volume(vol, sound._id, true)
            }

            // Set the group's volume.
            if (isGroup) this._volume = vol

            // When the fade is complete, stop it and fire event.
            if ((to < from && vol <= to) || (to > from && vol >= to)) {
                clearInterval(sound._interval)
                sound._interval = null
                sound._fadeTo = null
                this.volume(to, sound._id)
                this._emit('fade', sound._id)
            }
        }, stepLen)
    }

    /**
     * Internal method that stops the currently playing fade when
     * a new fade starts, volume is changed or the sound is stopped.
     * @param  {Number} id The sound id.
     */
    /** @internal */
    public _stopFade(id: number): void {
        const sound = this._soundById(id)
        if (sound && sound._interval) {
            if (this._webAudio) {
                ;(sound._node as GainNode).gain.cancelScheduledValues(Howler.ctx!.currentTime)
            }
            clearInterval(sound._interval)
            sound._interval = null
            this.volume(sound._fadeTo!, id)
            sound._fadeTo = null
            this._emit('fade', id)
        }
    }

    /**
     * Buffer a sound from URL, Data URI or cache and decode to audio source (Web Audio API).
     */
    /** @internal */
    public _loadBuffer(): void {
        const url = this._src as string

        // Check if the buffer has already been cached and use it instead.
        if (bufferCache[url]) {
            this._duration = bufferCache[url].duration
            this._loadSound(bufferCache[url])
            return
        }

        if (/^data:[^;]+;base64,/.test(url)) {
            // Decode the base64 data URI without XHR, since some browsers don't support it.
            const data = atob(url.split(',')[1])
            const dataView = new Uint8Array(data.length)
            for (let i = 0; i < data.length; ++i) {
                dataView[i] = data.charCodeAt(i)
            }
            this._decodeAudioData(dataView.buffer)
        } else {
            // Load the buffer from the URL.
            const xhr = new XMLHttpRequest()
            xhr.open(this._xhr.method, url, true)
            xhr.withCredentials = this._xhr.withCredentials
            xhr.responseType = 'arraybuffer'

            // Apply any custom headers to the request.
            if (this._xhr.headers) {
                Object.keys(this._xhr.headers).forEach((key) => {
                    xhr.setRequestHeader(key, this._xhr.headers![key])
                })
            }

            xhr.onload = () => {
                // Make sure we get a successful response back.
                const code = (xhr.status + '')[0]
                if (code !== '0' && code !== '2' && code !== '3') {
                    this._emit('loaderror', undefined, 'Failed loading audio file with status: ' + xhr.status + '.')
                    return
                }
                this._decodeAudioData(xhr.response)
            }

            xhr.onerror = () => {
                // If there is an error, switch to HTML5 Audio.
                if (this._webAudio) {
                    this._html5 = true
                    this._webAudio = false
                    this._sounds = []
                    if (bufferCache[url]) delete bufferCache[url]
                    this.load()
                }
            }

            // Send the XHR request wrapped in a try/catch.
            try {
                xhr.send()
            } catch (e) {
                xhr.onerror(null!)
            }
        }
    }

    /**
     * Decode audio data from an array buffer.
     * @param  {ArrayBuffer} arraybuffer The audio data.
     */
    /** @internal */
    public _decodeAudioData(arraybuffer: ArrayBuffer): void {
        // Fire a load error if something broke.
        const error = () => {
            this._emit('loaderror', undefined, 'Decoding audio data failed.')
        }

        // Load the sound on success.
        const success = (buffer: AudioBuffer) => {
            if (buffer && this._sounds.length > 0) {
                bufferCache[this._src as string] = buffer
                this._loadSound(buffer)
            } else {
                error()
            }
        }

        // Decode the buffer into an audio source.
        if (typeof Promise !== 'undefined' && Howler.ctx!.decodeAudioData.length === 1) {
            Howler.ctx!.decodeAudioData(arraybuffer).then(success).catch(error)
        } else {
            Howler.ctx!.decodeAudioData(arraybuffer, success, error)
        }
    }

    /**
     * Sound is now loaded, so finish setting everything up and fire the loaded event.
     * @param  {Howl} self
     * @param  {Object} buffer The decoded buffer sound source.
     */
    /** @internal */
    public _loadSound(buffer?: AudioBuffer): void {
        // Set the duration.
        if (buffer && !this._duration) {
            this._duration = buffer.duration
        }

        // Setup a sprite if none is defined.
        if (Object.keys(this._sprite).length === 0) {
            this._sprite = { __default: [0, this._duration * 1000] }
        }

        // Fire the loaded event.
        if (this._state !== 'loaded') {
            this._state = 'loaded'
            this._emit('load')
            this._loadQueue()
        }
    }
}
