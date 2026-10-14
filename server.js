const WebSocket = require("ws")
const { performance } = require("perf_hooks")
const PORT = process.env.PORT || 10000

// perMessageDeflate off: compressing a ~1 KB snapshot 60x/s costs CPU time and adds latency for no real gain.
// maxPayload: real messages are a few hundred bytes; anything big is junk.
const wss = new WebSocket.Server({ port: PORT, perMessageDeflate: false, maxPayload: 4096 })

// ==SIM_BEGIN== (shared with the client: embed_sim.js copies everything up to SIM_END into the HTML game)
// ─── Network tuning ──────────────────────────────────────────────────────────
const TICK_MS             = 1000 / 60
const MAX_CATCHUP_TICKS   = 3          // after a stall, run at most this many ticks back-to-back, then resync
const SPIN_MS             = 2          // last stretch before a tick is waited out with setImmediate (setTimeout is ~1 ms coarse); lower = less CPU, more jitter
const TAP_BUFFER_TICKS    = 6          // a tap pressed during hitstop/freeze survives this long (client: INPUT_BUFFER_FRAMES)
const MAX_BUFFERED_BYTES  = 8 * 1024   // per-socket send backlog above which a snapshot is dropped instead of queued
const PING_INTERVAL_MS    = 20000      // keepalive + dead-peer detection
const NET_DEBUG           = (typeof process !== "undefined") && !!process.env.NET_DEBUG   // NET_DEBUG=1 logs tick lateness / cost every 5 s
const NET_ACTIONS         = new Set(["left","right","jump","down","attack","dash","parry","ultimate"])

// ─── Physics constants (must match client) ───────────────────────────────────
const GRAVITY            = 0.8
const AIR_ACCEL          = 0.6
const GROUND_ACCEL       = 1.0
const JUMP_POWER         = 18
const SHORT_HOP_POWER    = 12
const MAX_FALL           = 12
const WALL_SLIDE_SPEED   = 1.5
const FAST_FALL_SPEED    = 18
const WALL_JUMP_BUFFER   = 6
const LAUNCH_AIR_DRAG    = 0.96
const LAUNCH_GROUND_DRAG = 0.78
const HIT_FALL_MULT      = 0.9
const DASH_SPEED         = 20      // ground tap-dash
const DASH_THRESHOLD     = 3
const NEUTRAL_DRAG_HITSTUN = 14

// Horizontal movement friction (client: MOVE_SNAP blend of the original + snappy values)
const MOVE_SNAP          = 0.25
const GROUND_RUN_SPEED   = 5.7
const AIR_RUN_SPEED      = 8
const mixMove            = (orig, snappy) => orig + (snappy - orig) * MOVE_SNAP
const GROUND_FRICTION_PCT  = mixMove(0.85, 0.975)
const GROUND_FRICTION_FLAT = mixMove(0,    0.6)
const AIR_FRICTION_PCT     = mixMove(0.93, 0.99)
const AIR_FRICTION_FLAT    = mixMove(0,    0.15)

// Combat tuning
const KB_PERCENT_SCALE       = 0.02
const HIT_ATTACKER_FREE_SHARE = 0.4
const HIT_METER_GAIN_SCALE   = 1.3

// Meter / shield
const SHIELD_MAX         = 150
const SHIELD_REGEN       = 0.05
const REGEN_MULT_LOW     = 2
const REGEN_MULT_MID     = 1.5
const REGEN_MULT_HIGH    = 1.2
const DEPTH_REGEN_START_Y        = 650
const DEPTH_REGEN_CAP_Y          = 900
const DEPTH_REGEN_MAX_BONUS      = 2.5
const DEPTH_REGEN_UNDER_STAGE    = 1.6

// Parry / dash / burst
const PARRY_COST         = 50
const PARRY_REFUND       = 20
const PARRY_WINDOW       = 15
const PARRY_DASH_SPEED   = 15
const PARRY_JUMP_BOOST   = 0.99
const DASH_SURFACE_EXTENSION_FRAMES = 15
const SLIDE_RELEASE_SPEEDS = [0, 0, 0]
const BURST_COST         = 100
const BURST_PARRY_COST   = 50
const BURST_PARRY_WIN    = 15
const BURST_PARRY_ATTEMPT_FRAMES = 15
const BURST_WINDUP_FRAMES = 20

// Flow (witch time) — off in the client right now, all code kept
const FLOW_ENABLED       = false
const WITCH_DURATION     = 300
const WITCH_SLOW         = 0.8
const WITCH_BOOST        = 1.02
const WITCH_ATK_BOOST    = 1.5
const WITCH_HITSTUN_MULT = 2.5

// Judgement Cut (client REND_TUNING)
const JC_RANGE_X         = 150
const JC_RANGE_Y         = 100
const JC_TOTAL_FRAMES    = 130     // freeze + cut flurry + finisher before the final hit lands
const JC_FINAL_KB        = 24
const JC_FINAL_ANGLE     = 30
const JC_FINAL_HITSTUN   = 12
const JC_FINAL_DAMAGE    = 30

// ─── Stage ───────────────────────────────────────────────────────────────────
const CANVAS_W = 1500
const CANVAS_H = 855
const CX = CANVAS_W / 2

const platforms = [
    { x: CX - 500, y: 500, w: 1000, h: 300, topOnly: false, isMainStage: true },
    { x: CX - 400, y: 320, w: 200,  h: 20,  topOnly: true  },
    { x: CX - 100, y: 120, w: 200,  h: 20,  topOnly: true  },
    { x: CX + 220, y: 320, w: 200,  h: 20,  topOnly: true  }
]

const blast = { left: -500, right: CANVAS_W + 500, top: -600, bottom: CANVAS_H + 600 }

const spawnPoints = [
    { x: 380, y: 200 },
    { x: 950, y: 200 }
]

// ─── Character move tables ────────────────────────────────────────────────────
function getMoveset(characterName, direction, onGround) {
    const moves = {
        speedster: {
            ground: {
                neutral: {
                    lockFrames: 20, cooldown: 35,
                    hitboxes: [
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.5,angle:30,kb:0,delayFrames:10,moveTag:"speedster-neutral-dragdown" },
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.5,angle:40,kb:0,delayFrames:18,moveTag:"speedster-neutral-dragdown" },
                        { offsetX:35,offsetY:-15,w:110,h:55,damage:1,  angle:40,kb:5,delayFrames:28,moveTag:"speedster-neutral-ground"   }
                    ]
                },
                forward: {
                    lockFrames: 10, cooldown: 25,
                    hitboxes: [{ offsetX:45,offsetY:-15,w:115,h:80,damage:3,  angle:40,kb:5,delayFrames:10,moveTag:"speedster-forward-air" }]
                },
                up: {
                    lockFrames: 12, cooldown: 25,
                    hitboxes: [{ offsetX:30,offsetY:-45,w:110,h:110,damage:3, angle:85,kb:9,delayFrames:6, moveTag:"speedster-up-ground"   }]
                },
                down: {
                    lockFrames: 15, cooldown: 25,
                    hitboxes: [{ offsetX:25,offsetY:-10,w:60, h:65, damage:4, angle:295,kb:8,delayFrames:8, moveTag:"speedster-up-ground"  }]
                }
            },
            air: {
                neutral: {
                    lockFrames: 18, cooldown: 40,
                    hitboxes: [
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.5,angle:30,kb:0,delayFrames:10,moveTag:"speedster-neutral-dragdown" },
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.5,angle:30,kb:0,delayFrames:18,moveTag:"speedster-neutral-dragdown" },
                        { offsetX:45,offsetY:-15,w:110,h:55,damage:1,  angle:40,kb:5,delayFrames:28,moveTag:"speedster-neutral-air"      }
                    ]
                },
                forward: {
                    lockFrames: 10, cooldown: 25,
                    hitboxes: [{ offsetX:45,offsetY:-15,w:115,h:80,damage:3.5,angle:40,kb:5,delayFrames:10,moveTag:"speedster-forward-air" }]
                },
                up: {
                    lockFrames: 10, cooldown: 25,
                    hitboxes: [{ offsetX:30,offsetY:-45,w:110,h:110,damage:2,angle:80,kb:8,delayFrames:6, moveTag:"speedster-up-ground"   }]
                },
                down: {
                    lockFrames: 12, cooldown: 25,
                    hitboxes: [{ offsetX:10,offsetY:20, w:80, h:80, damage:3,angle:280,kb:6,delayFrames:10,moveTag:"speedster-down-air"   }]
                }
            }
        },
        mage: {
            ground: {
                neutral: { lockFrames:10,cooldown:5, hitboxes:[{ offsetX:30,offsetY:10,w:50,h:50,damage:3,angle:45, kb:4,delayFrames:0,moveTag:"mage-neutral-ground"  }] },
                forward: { lockFrames:14,cooldown:5, hitboxes:[{ offsetX:60,offsetY:5, w:30,h:60,damage:5,angle:30, kb:6,delayFrames:0,moveTag:"mage-forward-ground" }] },
                up:      { lockFrames:12,cooldown:5, hitboxes:[{ offsetX:-10,offsetY:-40,w:60,h:60,damage:2,angle:90,kb:9,delayFrames:0,moveTag:"mage-up-ground"     }] },
                down:    { lockFrames:10,cooldown:5, hitboxes:[{ offsetX:0,offsetY:40, w:60,h:30,damage:3,angle:285,kb:8,delayFrames:0,moveTag:"mage-down-ground"    }] }
            },
            air: {
                neutral: { lockFrames:10,cooldown:5, hitboxes:[{ offsetX:30,offsetY:10,w:50,h:50,damage:3,angle:45, kb:4,delayFrames:0,moveTag:"mage-neutral-ground"  }] },
                forward: { lockFrames:14,cooldown:5, hitboxes:[{ offsetX:60,offsetY:5, w:30,h:60,damage:5,angle:30, kb:6,delayFrames:0,moveTag:"mage-forward-ground" }] },
                up:      { lockFrames:12,cooldown:5, hitboxes:[{ offsetX:-10,offsetY:-40,w:60,h:60,damage:2,angle:90,kb:9,delayFrames:0,moveTag:"mage-up-ground"     }] },
                down:    { lockFrames:10,cooldown:5, hitboxes:[{ offsetX:0,offsetY:40, w:60,h:30,damage:3,angle:285,kb:8,delayFrames:0,moveTag:"mage-down-ground"    }] }
            }
        },
        ninja: {
            ground: {
                neutral: {
                    lockFrames:30,cooldown:35,
                    hitboxes:[
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.25,angle:30,kb:0,delayFrames:8, moveTag:"speedster-neutral-dragdown" },
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.25,angle:40,kb:0,delayFrames:16,moveTag:"speedster-neutral-dragdown" },
                        { offsetX:35,offsetY:-15,w:110,h:55,damage:0.5, angle:40,kb:6,delayFrames:28,moveTag:"speedster-neutral-ground"   }
                    ]
                },
                forward: { lockFrames:12,cooldown:25,hitboxes:[{ offsetX:45,offsetY:18,w:36,h:20,damage:2,angle:40,kb:4,delayFrames:0,moveTag:"speedster-forward-ground" }] },
                up:      { lockFrames:18,cooldown:25,hitboxes:[{ offsetX:30,offsetY:-45,w:110,h:110,damage:2,angle:85,kb:9,delayFrames:6,moveTag:"speedster-up-ground"    }] },
                down:    { lockFrames:12,cooldown:25,hitboxes:[{ offsetX:10,offsetY:40, w:70, h:20,damage:2,angle:70, kb:6,multihit:true,delayFrames:0,moveTag:"speedster-down-ground"  }] }
            },
            air: {
                neutral: {
                    lockFrames:20,cooldown:40,
                    hitboxes:[
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.25,angle:30,kb:0,delayFrames:8, moveTag:"speedster-neutral-dragdown" },
                        { offsetX:35,offsetY:-35,w:110,h:85,damage:0.25,angle:30,kb:0,delayFrames:16,moveTag:"speedster-neutral-dragdown" },
                        { offsetX:45,offsetY:-15,w:110,h:55,damage:0.55,angle:40,kb:5,delayFrames:28,moveTag:"speedster-neutral-air"      }
                    ]
                },
                forward: { lockFrames:12,cooldown:25,hitboxes:[{ offsetX:40,offsetY:10,w:60,h:40,damage:2,angle:40,kb:6,delayFrames:0,moveTag:"speedster-forward-air" }] },
                up:      { lockFrames:16,cooldown:25,hitboxes:[{ offsetX:30,offsetY:-45,w:110,h:110,damage:1,angle:80,kb:6,delayFrames:6,moveTag:"speedster-up-ground" }] },
                down:    { lockFrames:18,cooldown:25,hitboxes:[{ offsetX:10,offsetY:20, w:80, h:80,damage:3,angle:290,kb:6,delayFrames:10,moveTag:"speedster-down-air" }] }
            }
        }
    }
    const ch = moves[characterName]
    if (!ch) return null
    const slot = onGround ? ch.ground : ch.air
    return slot[direction] || null
}

// ─── Fighter state factory ────────────────────────────────────────────────────
function makeFighter(playerIndex, characterName) {
    const sp = spawnPoints[playerIndex]
    return {
        x: sp.x, y: sp.y,
        w: 42,   h: 58,
        vx: 0,   vy: 0,
        facing: playerIndex === 0 ? 1 : -1,
        characterName,
        percent: 0,
        stocks: 3,
        onGround: false,
        doubleJump: true,
        hitstun: 0,
        launchKB: 0,
        iFrames: 0,
        shield: SHIELD_MAX,
        shieldMax: SHIELD_MAX,
        parryFrames: 0,
        parryDashFrames: 0,
        parryDashVX: 0,
        parryDashVY: 0,
        parryDashStoredVX: null,
        parryDashStoredVY: null,
        dashSurfaceExtended: false,
        dashSurfaceExtendedFromVX: 0,
        dashSurfaceExtendedFromVY: 0,
        underStageCeiling: false,
        freeParryDashCharges: 0,
        burstParryWindow: 0,
        burstParryAttempted: false,
        burstParryAttemptFrames: 0,
        burstHoverFrames: 0,
        freezeFrames: 0,
        attackCooldown: 0,
        attackLockFrames: 0,
        dashCooldown: 0,
        dashDir: 0,
        dashLockFrames: 0,
        airDashBufferFrames: 0,
        airDashBufferDir: 0,
        moveInputDir: 0,
        inputSpeedCeiling: null,
        releaseFrames: 0,
        releaseFn: null,
        releaseStep: 0,
        releaseVX: 0,
        releaseVY: 0,
        grapple: null,
        grappleWindowFrames: 0,
        jumpSquatFrames: 0,
        jumpQueued: false,
        jumpSquatStartedThisFrame: false,
        jumpSquatHoldFrames: 0,
        touchingWall: 0,
        maxWallJumps: 3,
        wallJumpsLeft: 3,
        wallJumpCount: 0,
        platformDrop: false,
        hitfallQueued: false,
        hitConfirmWindow: 0,
        pendingLaunch: null,
        launchVelX: 0,
        launchVelY: 0,
        delayedHitboxes: [],
        hitboxes: [],
        moveStaleQueue: [],
        comboCount: 0,
        comboVictim: null,
        ultimateChargeFrames: 0,
        ultimateMaxCharge: 30,
        ultimateActive: false,
        witchTimeOwner: false,
        witchTimeVictim: false,
        trailingPercent: 0,
        damageFlash: 0,
        flashEffects: [],
        flowEmpowered: false
    }
}

// ─── Hitbox class ─────────────────────────────────────────────────────────────
class SHitbox {
    constructor(owner, offsetX, offsetY, w, h, damage, angle, kb, multihit, moveTag) {
        this.owner    = owner
        this.offsetX  = offsetX
        this.offsetY  = offsetY
        this.w        = w
        this.h        = h
        this.damage   = damage
        this.angle    = angle
        this.kb       = kb
        this.frames   = 10
        this.multihit = multihit || false
        this.moveTag  = moveTag || "generic"
        this.fixedKb      = null   // if set: knockback is exactly this (no percent scaling / staling / kill boost)
        this.fixedHitstun = null   // if set: hitstun is exactly this many frames
        this.hitTargets = new Set()
        this.x = 0
        this.y = 0
    }
    update() {
        this.frames--
        this.x = this.owner.x + this.owner.w / 2 + (this.offsetX * this.owner.facing) - this.w / 2
        this.y = this.owner.y + this.offsetY
    }
    active() { return this.frames > 0 }
}

// ─── Game state ───────────────────────────────────────────────────────────────
let G = null   // the game currently being ticked (collision code needs to set hitstop)

function makeGame(characters) {
    return {
        fighters: [
            makeFighter(0, characters[0]),
            makeFighter(1, characters[1])
        ],
        witchTime: { frames: 0, ownerIdx: -1, targetIdx: -1 },
        hitstopFrames: 0,
        attackerFreezeIdx: -1,
        attackerFreezeFrames: 0,
        frame: 0,
        controlsRan: [false, false],   // did processControls run for fighter i this tick? (taps are buffered if not)
        gameOver: false,
        winnerIdx: -1,
        pendingEvents: [],   // delayed: { type, data, applyAtFrame }
        vfxOut: [],          // events delivered to clients in this tick's packet
        pendingBursts: [],   // { frames, x, y, ownerIdx } — burst windup
        burstWaves: []       // live burst waves
    }
}

// Immediate VFX signal for clients
function emit(g, type, data) { g.vfxOut.push({ type, data }) }
// Delayed event (counted in frames); applyPendingEvent may mutate state, then it is forwarded to clients
function schedule(g, delayFrames, type, data) {
    g.pendingEvents.push({ type, data, applyAtFrame: g.frame + delayFrames })
}

// ─── Stale-move helpers ───────────────────────────────────────────────────────
function getStaleKey(moveTag, onGround) {
    if (["speedster-neutral-ground","speedster-neutral-air","speedster-neutral-dragdown"].includes(moveTag))
        return "speedster-neutral"
    return `${moveTag}:${onGround ? "ground" : "air"}`
}

function getStaleFactor(f, moveTag) {
    const key   = getStaleKey(moveTag, f.onGround)
    const count = f.moveStaleQueue.filter(v => v === key).length
    if (count <= 1) return 1
    const repeats = count - 1
    const t = Math.min(repeats / 8, 1)
    return Math.max(0, 1 - t * t)
}

function recordMove(f, moveTag) {
    const key = getStaleKey(moveTag, f.onGround)
    f.moveStaleQueue.push(key)
    if (f.moveStaleQueue.length > 8) f.moveStaleQueue.shift()
}

// ─── Meter ────────────────────────────────────────────────────────────────────
function gainMeter(f, amount, keepFraction) {
    const gain = Math.max(0, keepFraction ? amount : Math.floor(amount))
    f.shield = Math.min(f.shieldMax, f.shield + gain)
}

function depthRegenMultiplier(f) {
    const stage = platforms.find(p => p.isMainStage)
    if (!stage) return 1
    const cy = f.y + f.h / 2
    if (cy <= DEPTH_REGEN_START_Y) return 1
    const t = Math.min(1, (cy - DEPTH_REGEN_START_Y) / (DEPTH_REGEN_CAP_Y - DEPTH_REGEN_START_Y))
    let mult = 1 + t * (DEPTH_REGEN_MAX_BONUS - 1)
    const underStage = f.x + f.w > stage.x && f.x < stage.x + stage.w && cy > stage.y + stage.h
    if (underStage) mult *= DEPTH_REGEN_UNDER_STAGE
    return mult
}

// ─── Counter-velocity bonus ───────────────────────────────────────────────────
function counterVelocityBonus(defender, launchAngleDeg, attackerFacing) {
    if (defender.hitstun <= 0) return { multiplier: 1, isCounter: false }
    const speed = Math.hypot(defender.vx, defender.vy)
    if (speed < 6)             return { multiplier: 1, isCounter: false }

    const launchAngle  = launchAngleDeg * Math.PI / 180
    const defAngle     = Math.atan2(defender.vy, defender.vx)
    const hitAngle     = Math.atan2(-Math.sin(launchAngle), Math.cos(launchAngle) * attackerFacing)
    let   angleDiff    = hitAngle - defAngle
    while (angleDiff >  Math.PI) angleDiff -= 2 * Math.PI
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI

    const deviation  = Math.abs(Math.abs(angleDiff) - Math.PI)
    const windowRad  = Math.PI / 3
    if (deviation > windowRad) return { multiplier: 1, isCounter: false }

    const perfectZone = 20 * Math.PI / 180
    const accuracy    = deviation <= perfectZone ? 1 : 1 - ((deviation - perfectZone) / (windowRad - perfectZone)) * 0.5
    const speedFactor = Math.min(1, Math.max(0, (speed - 2) / 16))
    const maxBonus    = 0.15 + speedFactor * 0.85
    const multiplier  = 1 + maxBonus * (0.4 + accuracy * 0.6)
    return { multiplier, isCounter: true }
}

// ─── Movement helpers (client: applyMoveFriction / accelerateInput) ──────────
function applyMoveFriction(vx, inputDir, runSpeed, ceiling, pct, flat) {
    const speed = Math.abs(vx)
    if (speed === 0) return 0
    const travelDir = Math.sign(vx)
    const full = Math.max(0, speed * pct - flat)
    if (inputDir !== travelDir) return travelDir * full
    let out = full
    if (speed <= runSpeed) out = speed - (speed - full) * (1 - MOVE_SNAP)
    if (ceiling !== null && out > ceiling) out = ceiling
    return travelDir * out
}

function accelerateInput(f, dir, accel) {
    f.inputSpeedCeiling = Math.max(f.onGround ? GROUND_RUN_SPEED : AIR_RUN_SPEED, Math.abs(f.vx))
    f.vx += dir * accel
}

// ─── Launch DI / hitstun (shared by real hits and the kill prediction) ───────
function applyLaunchDI(baseVx, baseVy, baseSpeed, input) {
    if (!input) return { vx: baseVx, vy: baseVy }
    const launchMag = Math.hypot(baseVx, baseVy) || 1
    const ux = baseVx / launchMag
    const uy = baseVy / launchMag
    const dot   = Math.max(-1, Math.min(1, ux * input.x + uy * input.y))
    const cross = ux * input.y - uy * input.x
    const maxAngleShift = 10 * Math.PI / 180
    const angleShift = Math.sign(cross || 1) * Math.pow(Math.abs(cross), 1.8) * maxAngleShift
    const cosA = Math.cos(angleShift), sinA = Math.sin(angleShift)
    const rotatedX = ux * cosA - uy * sinA
    const rotatedY = ux * sinA + uy * cosA
    const kbMultiplier = Math.max(0.6, Math.min(1.25, 1 + dot * 0.15))
    const finalMag = baseSpeed * kbMultiplier
    return { vx: rotatedX * finalMag, vy: rotatedY * finalMag }
}

function computeBaseHitstun(rawKb, launchAngle, staleHitstunFactor, attacker) {
    const verticalFactor = Math.abs(Math.sin(launchAngle))
    const vhm = 1 - verticalFactor * 0.6
    let baseHitstun = Math.floor((rawKb + 5) * 2.5 * vhm * (staleHitstunFactor + 0.5) / 1.5)
    if (attacker.witchTimeOwner) baseHitstun *= WITCH_HITSTUN_MULT
    return Math.max(0, baseHitstun)
}

// ─── Kill prediction (neutral-DI trajectory, same rules the real fighter uses in hitstun)
function simStageCollide(s, stepVy) {
    for (const p of platforms) {
        const isTopOnly = p.topOnly
        if (s.x + s.w > p.x && s.x < p.x + p.w) {
            if (s.y + s.h > p.y && s.y + s.h - stepVy <= p.y + 1) {
                if (isTopOnly && s.platformDrop) continue
                if (s.vy >= 0) {
                    if (s.hitstun > 0 && s.vy >= 4) s.vy = -Math.abs(s.vy) * 0.92
                    else s.vy = 0
                    s.y = p.y - s.h
                    s.onGround = true
                }
            }
            const justCrossedIntoCeiling = s.y < p.y + p.h && s.y - stepVy >= p.y + p.h - 1
            const restingOnCeiling = Math.abs(s.y - (p.y + p.h)) < 1.5 && s.vy <= 0.5
            if (p.isMainStage && (justCrossedIntoCeiling || restingOnCeiling)) {
                if (s.vy <= 0.5) { s.vy = 0; s.y = p.y + p.h; s.underStageCeiling = true }
            }
        }
        if (!isTopOnly) {
            if (s.y + s.h > p.y && s.y < p.y + p.h) {
                if (s.x + s.w > p.x && s.x + s.w < p.x + 15) {
                    s.touchingWall = 1; s.x = p.x - s.w
                    if (s.hitstun > 0) s.vx = -s.vx; else s.vx = 0
                }
                if (s.x < p.x + p.w && s.x > p.x + p.w - 15) {
                    s.touchingWall = -1; s.x = p.x + p.w
                    if (s.hitstun > 0) s.vx = -s.vx; else s.vx = 0
                }
            }
        }
    }
    if (s.touchingWall === 0) {
        for (const p of platforms) {
            if (p.topOnly) continue
            if (s.y + s.h > p.y && s.y < p.y + p.h) {
                if (s.x + s.w <= p.x && s.x + s.w >= p.x - WALL_JUMP_BUFFER) s.touchingWall = 1
                if (s.x >= p.x + p.w && s.x <= p.x + p.w + WALL_JUMP_BUFFER) s.touchingWall = -1
            }
        }
    }
}

function simulateKnockback(def, vx, vy, hitstun, slowFrames) {
    const s = {
        x: def.x, y: def.y, w: def.w, h: def.h, vx, vy,
        onGround: !!def.onGround, touchingWall: 0, underStageCeiling: false,
        hitstun, platformDrop: false
    }
    let frame = 0
    while (s.hitstun > 0 && frame < 600) {
        frame++
        s.hitstun--
        s.vy += GRAVITY * (HIT_FALL_MULT - 1)
        const slow = frame <= slowFrames ? WITCH_SLOW : 1
        s.vy += GRAVITY * slow

        if (s.hitstun > 0) {
            const drag = s.onGround ? LAUNCH_GROUND_DRAG : LAUNCH_AIR_DRAG
            s.vx *= drag; s.vy *= drag
            if (s.vy > MAX_FALL) { s.vy -= 0.3; if (s.vy < MAX_FALL) s.vy = MAX_FALL }
            if (Math.abs(s.vx) < 0.08) s.vx = 0
            if (Math.abs(s.vy) < 0.08) s.vy = 0
        } else {
            if (s.vy > MAX_FALL) s.vy = MAX_FALL
            if (s.onGround) s.vx = applyMoveFriction(s.vx, 0, GROUND_RUN_SPEED, null, GROUND_FRICTION_PCT, GROUND_FRICTION_FLAT)
            else {
                s.vx = applyMoveFriction(s.vx, 0, AIR_RUN_SPEED, null, AIR_FRICTION_PCT, AIR_FRICTION_FLAT)
                if (s.vx > 25) s.vx = 25
                if (s.vx < -25) s.vx = -25
            }
        }

        let moveVx = s.vx * slow, moveVy = s.vy * slow
        const maxDisplace = Math.min(s.w, s.h) * 2
        const moveMag = Math.sqrt(moveVx * moveVx + moveVy * moveVy)
        if (moveMag > maxDisplace) { const k = maxDisplace / moveMag; moveVx *= k; moveVy *= k }

        s.onGround = false; s.touchingWall = 0; s.underStageCeiling = false

        const speed = Math.sqrt(moveVx * moveVx + moveVy * moveVy)
        if (speed > 0) {
            const maxStep = Math.min(s.w, s.h) / 4
            const steps = Math.max(1, Math.ceil(speed / maxStep))
            const dx = moveVx / steps, dy = moveVy / steps
            for (let i = 0; i < steps; i++) {
                s.x += dx; s.y += dy
                simStageCollide(s, dy)
                if (s.onGround && dy > 0) break
                if (s.underStageCeiling && dy < 0) break
            }
        }
        if (s.touchingWall !== 0 && !s.onGround) s.vy = Math.min(s.vy, WALL_SLIDE_SPEED * slow)

        const extra = s.hitstun > 0 ? 0 : 200
        if (s.x < blast.left - extra || s.x > blast.right + extra ||
            s.y < blast.top - extra  || s.y > blast.bottom + extra) return true
    }
    return false
}

function predictKillHit(defender, attacker, kb, launchAngle, hitstun, g) {
    if (hitstun <= 0) return false
    const baseVx = Math.cos(launchAngle) * kb * attacker.facing
    const baseVy = -Math.sin(launchAngle) * kb
    const slowFrames = defender.witchTimeVictim ? g.witchTime.frames : 0
    const launch = applyLaunchDI(baseVx, baseVy, kb, null)
    return simulateKnockback(defender, launch.vx, launch.vy, hitstun, slowFrames)
}

// ─── Physics ──────────────────────────────────────────────────────────────────
function applyDashSurfaceExtension(f, axis, dir) {
    if (f.parryDashFrames <= 0) return false
    if (f.dashSurfaceExtended) return false
    if (Math.abs(f.parryDashVX) < 0.01 || Math.abs(f.parryDashVY) < 0.01) return false

    f.dashSurfaceExtendedFromVX = f.parryDashVX
    f.dashSurfaceExtendedFromVY = f.parryDashVY

    if (axis === "horizontal") {
        f.parryDashVX = PARRY_DASH_SPEED * dir; f.parryDashVY = 0
        f.vx = f.parryDashVX; f.vy = 0
    } else {
        f.parryDashVY = PARRY_DASH_SPEED * dir; f.parryDashVX = 0
        f.vy = f.parryDashVY; f.vx = 0
    }
    f.parryDashFrames += DASH_SURFACE_EXTENSION_FRAMES
    f.dashSurfaceExtended = true
    return true
}

function checkStageCollision(f, stepVy) {
    for (const p of platforms) {
        const isTop = p.topOnly
        if (f.x + f.w > p.x && f.x < p.x + p.w) {
            if (f.y + f.h > p.y && f.y + f.h - stepVy <= p.y + 1) {
                if (isTop && f.platformDrop) continue
                if (f.vy >= 0) {
                    if (f.hitstun > 0 && f.vy >= 4) {
                        f.vy = -Math.abs(f.vy) * 0.92
                        f.percent += 0.5
                        f.damageFlash = 6
                        if (G) G.hitstopFrames = 4
                    } else {
                        f.vy = 0
                    }
                    f.y = p.y - f.h
                    f.onGround = true
                    f.wallJumpsLeft = f.maxWallJumps
                    f.wallJumpCount = 0

                    if (f.parryDashFrames > 0) {
                        const extended = applyDashSurfaceExtension(f, "horizontal", f.parryDashVX < 0 ? -1 : 1)
                        if (!extended) f.parryDashVY = 0
                    }
                }
            }

            const dashingNow = f.parryDashFrames > 0
            const justCrossedIntoCeiling = f.y < p.y + p.h && f.y - stepVy >= p.y + p.h - 1
            const restingOnCeiling = Math.abs(f.y - (p.y + p.h)) < 1.5 && f.vy <= 0.5
            if ((p.isMainStage || (isTop && dashingNow)) && (justCrossedIntoCeiling || restingOnCeiling)) {
                if (f.vy <= 0.5) {
                    f.vy = 0
                    f.y = p.y + p.h
                    f.underStageCeiling = true
                    if (f.parryDashFrames > 0) applyDashSurfaceExtension(f, "horizontal", f.parryDashVX < 0 ? -1 : 1)
                }
            }
        }

        if (!isTop) {
            if (f.y + f.h > p.y && f.y < p.y + p.h) {
                if (f.x + f.w > p.x && f.x + f.w < p.x + 15) {
                    const CORNER_CORRECT_PX = 6
                    const dashingUp = f.parryDashFrames > 0 && f.parryDashVY < -1
                    const topOverlap = (p.y + p.h) - f.y
                    if (dashingUp && topOverlap > 0 && topOverlap <= CORNER_CORRECT_PX) {
                        f.y = p.y + p.h + 1
                    } else {
                        f.touchingWall = 1
                        f.wallJumpsLeft = f.maxWallJumps
                        f.wallJumpCount = 0
                        f.x = p.x - f.w
                        if (f.hitstun > 0) {
                            f.vx = -f.vx; f.percent += 0.5; f.damageFlash = 6
                            if (G) G.hitstopFrames = 4
                        } else {
                            f.vx = 0
                            if (f.parryDashFrames > 0) applyDashSurfaceExtension(f, "vertical", -1)
                        }
                    }
                }
                if (f.x < p.x + p.w && f.x > p.x + p.w - 15) {
                    const CORNER_CORRECT_PX = 6
                    const dashingUp = f.parryDashFrames > 0 && f.parryDashVY < -1
                    const topOverlap = (p.y + p.h) - f.y
                    if (dashingUp && topOverlap > 0 && topOverlap <= CORNER_CORRECT_PX) {
                        f.y = p.y + p.h + 1
                    } else {
                        f.touchingWall = -1
                        f.x = p.x + p.w
                        if (f.hitstun > 0) {
                            f.vx = -f.vx; f.percent += 0.5; f.damageFlash = 6
                            if (G) G.hitstopFrames = 4
                        } else {
                            f.vx = 0
                            if (f.parryDashFrames > 0) applyDashSurfaceExtension(f, "vertical", -1)
                        }
                    }
                }
            }
        }
    }
    if (f.touchingWall === 0) {
        for (const p of platforms) {
            if (p.topOnly) continue
            if (f.y + f.h > p.y && f.y < p.y + p.h) {
                if (f.x + f.w <= p.x && f.x + f.w >= p.x - WALL_JUMP_BUFFER) f.touchingWall = 1
                if (f.x >= p.x + p.w && f.x <= p.x + p.w + WALL_JUMP_BUFFER)  f.touchingWall = -1
            }
        }
    }
}

function safeMove(f, totalVx, totalVy) {
    const speed = Math.sqrt(totalVx * totalVx + totalVy * totalVy)
    if (speed === 0) return
    const maxStep = Math.min(f.w, f.h) / 4
    const steps   = Math.max(1, Math.ceil(speed / maxStep))
    const dx = totalVx / steps
    const dy = totalVy / steps
    for (let s = 0; s < steps; s++) {
        f.x += dx
        f.y += dy
        checkStageCollision(f, dy)
        if (f.onGround && dy > 0) break
        if (f.underStageCeiling && dy < 0) break
    }
}

function applyPhysics(f, inp, g) {
    if (f.parryDashFrames > 0) {
        f.vx = f.parryDashVX
        f.vy = f.parryDashVY
        const wasOnGround = f.onGround
        f.onGround = false
        f.touchingWall = 0
        f.underStageCeiling = false
        safeMove(f, f.vx, f.vy)

        // Ground-hugging: a flat dash off a ledge snaps back down so it doesn't float
        if (!f.onGround && wasOnGround && Math.abs(f.parryDashVY) < 0.001) {
            for (const p of platforms) {
                if (p.topOnly && f.platformDrop) continue
                if (f.x + f.w > p.x && f.x < p.x + p.w && Math.abs((f.y + f.h) - p.y) <= 10) {
                    f.y = p.y - f.h; f.onGround = true; f.vy = 0; break
                }
            }
        }

        if (f.onGround) {
            f.doubleJump = true
            f.wallJumpsLeft = f.maxWallJumps
            if (!wasOnGround && f.attackCooldown > 0) f.attackCooldown = Math.max(0, f.attackCooldown - 10)
        } else {
            if (wasOnGround && f.hitstun <= 0 && f.attackCooldown > 0) f.attackCooldown = Math.max(0, f.attackCooldown - 15)
        }
        checkBlast(f, g)
        return
    }

    const slow = f.witchTimeVictim ? WITCH_SLOW : f.witchTimeOwner ? WITCH_BOOST : 1

    if (f.burstHoverFrames > 0) {
        f.vy = -0.2
        f.vx *= 0.2
        f.burstHoverFrames--
        return
    }

    f.vy += GRAVITY * slow

    if (f.hitfallQueued && !f.onGround && f.touchingWall === 0 && f.hitstun <= 0) {
        f.vy = FAST_FALL_SPEED * slow
        f.hitfallQueued = false
    }

    if (!f.onGround) {
        if (inp.held.down) {
            if (f.hitstun <= 0) {
                if (f.vy > 0) f.vy = Math.min(f.vy + 1 * slow, FAST_FALL_SPEED * slow)
                else f.vy += 0.3 * slow
            }
        } else if (inp.held.jump) {
            if (f.hitstun <= 0) {
                const cutoff = MAX_FALL * 0.35
                if (f.vy > 0 && f.vy < cutoff) f.vy *= 0.85
                else if (f.vy <= 0) f.vy -= 0.2 * slow
            }
        }
    }

    if (f.hitstun > 0) {
        const drag = f.onGround ? LAUNCH_GROUND_DRAG : LAUNCH_AIR_DRAG
        f.vx *= drag; f.vy *= drag
        if (f.vy > MAX_FALL) { f.vy -= 0.3; if (f.vy < MAX_FALL) f.vy = MAX_FALL }
        if (Math.abs(f.vx) < 0.08) f.vx = 0
        if (Math.abs(f.vy) < 0.08) f.vy = 0
    } else {
        if (f.vy > MAX_FALL && !inp.held.down) f.vy = MAX_FALL
        if (f.onGround) {
            f.vx = applyMoveFriction(f.vx, f.moveInputDir, GROUND_RUN_SPEED, f.inputSpeedCeiling, GROUND_FRICTION_PCT, GROUND_FRICTION_FLAT)
        } else if (f.freezeFrames <= 0) {
            f.vx = applyMoveFriction(f.vx, f.moveInputDir, AIR_RUN_SPEED, f.inputSpeedCeiling, AIR_FRICTION_PCT, AIR_FRICTION_FLAT)
            if (f.vx >  25) f.vx =  25
            if (f.vx < -25) f.vx = -25
        }
    }

    let mvx = f.vx * slow
    let mvy = f.vy * slow
    const maxD = Math.min(f.w, f.h) * 2
    const mag  = Math.sqrt(mvx * mvx + mvy * mvy)
    if (mag > maxD) { mvx *= maxD / mag; mvy *= maxD / mag }

    const wasOnGround = f.onGround
    f.onGround = false
    f.touchingWall = 0
    f.underStageCeiling = false
    safeMove(f, mvx, mvy)

    if (f.onGround) {
        f.doubleJump = true
        f.wallJumpsLeft = f.maxWallJumps
        if (!wasOnGround && f.attackCooldown > 0) f.attackCooldown -= 10
    }
    if (f.touchingWall !== 0 && !f.onGround && !inp.held.down) {
        f.vy = Math.min(f.vy, WALL_SLIDE_SPEED * slow)
    }

    updateGrapple(f, g)
    checkBlast(f, g)
}

// ─── Grapple (swing off a surface after a parry dash) ────────────────────────
function raySegmentIntersect(cx, cy, rdx, rdy, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1
    const denom = rdx * dy - rdy * dx
    if (Math.abs(denom) < 1e-10) return null
    const t = ((x1 - cx) * dy - (y1 - cy) * dx) / denom
    const u = ((x1 - cx) * rdy - (y1 - cy) * rdx) / denom
    if (t < 0 || u < 0 || u > 1) return null
    return t
}

function tryStartGrapple(f, opp) {
    const useVX = f.parryDashFrames > 0 ? f.parryDashVX : f.vx
    const useVY = f.parryDashFrames > 0 ? f.parryDashVY : f.vy
    const speed = Math.hypot(useVX, useVY)
    if (speed < 1) return false

    const cx = f.x + f.w / 2
    const cy = f.y + f.h / 2
    const MAX_ROPE = 300
    const MIN_ROPE = 100
    const CONE_HALF_ANGLE = 15 * Math.PI / 180

    const perpX = -useVY / speed
    const perpY =  useVX / speed

    const rotate = (dx, dy, a) => ({ x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) })

    const isBlocked = (rdx, rdy, tMax, excludePlat) => {
        for (const blocker of platforms) {
            if (blocker === excludePlat) continue
            if (blocker.topOnly) continue
            const sides = [
                [blocker.x, blocker.y, blocker.x + blocker.w, blocker.y],
                [blocker.x, blocker.y + blocker.h, blocker.x + blocker.w, blocker.y + blocker.h],
                [blocker.x, blocker.y, blocker.x, blocker.y + blocker.h],
                [blocker.x + blocker.w, blocker.y, blocker.x + blocker.w, blocker.y + blocker.h]
            ]
            for (const [x1, y1, x2, y2] of sides) {
                const tb = raySegmentIntersect(cx, cy, rdx, rdy, x1, y1, x2, y2)
                if (tb !== null && tb > 4 && tb < tMax - 4) return true
            }
        }
        return false
    }

    const hits = []
    const coneAngles = [-CONE_HALF_ANGLE, 0, CONE_HALF_ANGLE]

    for (const sign of [1, -1]) {
        const baseDX = perpX * sign
        const baseDY = perpY * sign
        for (const coneAngle of coneAngles) {
            const { x: rdx, y: rdy } = rotate(baseDX, baseDY, coneAngle)
            for (const plat of platforms) {
                const isMainFloor = !plat.topOnly && plat.w >= 800
                const surfaces = []
                if (!isMainFloor) {
                    surfaces.push({ x1: plat.x, y1: plat.y, x2: plat.x + plat.w, y2: plat.y, platRef: plat, kind: "top" })
                }
                if (!plat.topOnly) {
                    surfaces.push({ x1: plat.x, y1: plat.y + plat.h, x2: plat.x + plat.w, y2: plat.y + plat.h, platRef: plat, kind: "bottom" })
                    surfaces.push({ x1: plat.x, y1: plat.y, x2: plat.x, y2: plat.y + plat.h, platRef: plat, kind: "left" })
                    surfaces.push({ x1: plat.x + plat.w, y1: plat.y, x2: plat.x + plat.w, y2: plat.y + plat.h, platRef: plat, kind: "right" })
                }
                for (const surf of surfaces) {
                    if (isMainFloor && (surf.kind === "top" || surf.kind === "bottom")) continue
                    const dx = surf.x2 - surf.x1
                    const dy = surf.y2 - surf.y1
                    const denom = rdx * dy - rdy * dx
                    if (Math.abs(denom) < 1e-10) continue
                    const t = ((surf.x1 - cx) * dy - (surf.y1 - cy) * dx) / denom
                    const u = ((surf.x1 - cx) * rdy - (surf.y1 - cy) * rdx) / denom
                    if (t < 8 || t > MAX_ROPE) continue
                    if (u < 0 || u > 1) continue
                    if (isBlocked(rdx, rdy, t, surf.platRef)) continue
                    hits.push({ dist: t, ax: cx + rdx * t, ay: cy + rdy * t })
                }
            }
        }
    }

    hits.sort((a, b) => a.dist - b.dist)
    const chosen = hits[0]
    if (!chosen) return false

    if (opp.hitstun > 0) opp.hitstun += 15

    const toPlayerX = cx - chosen.ax
    const toPlayerY = cy - chosen.ay
    const cross = toPlayerX * useVY - toPlayerY * useVX
    const swingDir = cross >= 0 ? 1 : -1
    const angleStart = Math.atan2(toPlayerY, toPlayerX)
    const startSpeed = Math.max(Math.hypot(useVX, useVY), 0.01)

    if (f.parryDashFrames > 0) {
        f.vx = useVX; f.vy = useVY
        abortParryDash(f, false)
        f.vx = useVX; f.vy = useVY
    }

    f.grapple = {
        anchorX: chosen.ax, anchorY: chosen.ay,
        radius: chosen.dist,
        targetRadius: Math.max(chosen.dist, MIN_ROPE),
        angleStart, angleCurrent: angleStart,
        dir: swingDir, swept: 0,
        speed: startSpeed, baseSpeed: startSpeed,
        speedGain: 0.5,
        maxSpeed: Math.max(startSpeed * 2, startSpeed + 20)
    }
    f.grappleWindowFrames = 0
    f.onGround = false
    return true
}

function updateGrapple(f, g) {
    if (!f.grapple) return
    const gr = f.grapple
    const opp = g.fighters[1 - g.fighters.indexOf(f)]

    const endGrapple = (boost) => {
        const currentSpeed = Math.hypot(f.vx, f.vy)
        if (currentSpeed > 0.001) { f.vx *= boost; f.vy *= boost }
        else {
            f.vx = -Math.sin(gr.angleCurrent) * gr.dir * gr.speed * boost
            f.vy =  Math.cos(gr.angleCurrent) * gr.dir * gr.speed * boost
        }
        f.grapple = null
    }

    if (gr.radius < gr.targetRadius) {
        gr.radius += Math.max(1, (gr.targetRadius - gr.radius) * 0.22)
        if (gr.radius >= gr.targetRadius - 0.25) gr.radius = gr.targetRadius
    }
    gr.speed = Math.min(gr.maxSpeed, gr.speed + gr.speedGain)

    const omega = gr.speed / Math.max(1, gr.radius)
    const dAngle = omega * gr.dir
    gr.angleCurrent += dAngle
    gr.swept += Math.abs(dAngle)

    const newCX = gr.anchorX + Math.cos(gr.angleCurrent) * gr.radius
    const newCY = gr.anchorY + Math.sin(gr.angleCurrent) * gr.radius
    f.x = newCX - f.w / 2
    f.y = newCY - f.h / 2

    const tangX = -Math.sin(gr.angleCurrent) * gr.dir
    const tangY =  Math.cos(gr.angleCurrent) * gr.dir
    f.vx = tangX * gr.speed
    f.vy = tangY * gr.speed

    const toOppX = (opp.x + opp.w / 2) - newCX
    const toOppY = (opp.y + opp.h / 2) - newCY
    const vMag = Math.hypot(f.vx, f.vy)
    const oppMag = Math.hypot(toOppX, toOppY)
    if (vMag > 0.001 && oppMag > 0.001) {
        const align = (f.vx * toOppX + f.vy * toOppY) / (vMag * oppMag)
        if (align >= 0.95) { endGrapple(1.15); return }
    }
    if (gr.swept >= Math.PI) { endGrapple(1.15); return }
    if (f.onGround || f.touchingWall !== 0) endGrapple(1.15)
}

// ─── Jump helpers ─────────────────────────────────────────────────────────────
function doJump(f, shortHop) {
    if (f.onGround) {
        f.vy = shortHop ? -SHORT_HOP_POWER : -JUMP_POWER
    } else if (f.touchingWall !== 0 && f.wallJumpsLeft > 0) {
        f.vy = -JUMP_POWER * 1.1
        f.vx = f.touchingWall * -15
        f.touchingWall = 0
        f.wallJumpsLeft--
        f.wallJumpCount++
        f.doubleJump = true
    } else if (f.doubleJump) {
        f.vy = -JUMP_POWER
        f.doubleJump = false
    }
}

function startJumpSquat(f) {
    f.jumpSquatFrames = 2; f.jumpQueued = true
    f.jumpSquatStartedThisFrame = true; f.jumpSquatHoldFrames = 0
}

function cancelJumpSquat(f) {
    f.jumpSquatFrames = 0; f.jumpQueued = false; f.jumpSquatStartedThisFrame = false
}

function advanceJumpSquat(f, inp) {
    if (f.jumpSquatFrames <= 0) return
    if (f.jumpSquatStartedThisFrame) { f.jumpSquatStartedThisFrame = false; return }
    if (inp.held.jump) f.jumpSquatHoldFrames++
    f.jumpSquatFrames--
    if (f.jumpSquatFrames === 0 && f.jumpQueued) {
        f.jumpQueued = false
        doJump(f, f.jumpSquatHoldFrames < 2)
        f.jumpSquatHoldFrames = 0
    }
}

// ─── Slide release (dash tech wind-up before a boost) ────────────────────────
function applySlideReleaseStep(f) {
    const fac = SLIDE_RELEASE_SPEEDS[f.releaseStep]
    f.moveInputDir = 0
    const pct  = f.onGround ? GROUND_FRICTION_PCT  : AIR_FRICTION_PCT
    const flat = f.onGround ? GROUND_FRICTION_FLAT : AIR_FRICTION_FLAT
    const target = Math.abs(f.releaseVX) * fac
    f.vx = target > 0 ? Math.sign(f.releaseVX) * (target + flat) / pct : 0
    f.vy = f.releaseVY * fac
}

function beginSlideRelease(f, release) {
    f.releaseFn = release
    f.releaseStep = 0
    f.releaseFrames = SLIDE_RELEASE_SPEEDS.length
    f.releaseVX = f.vx
    f.releaseVY = f.vy
    applySlideReleaseStep(f)
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function processControls(f, opp, inp, taps, g) {
    f.moveInputDir = 0
    f.inputSpeedCeiling = null

    if (f.hitstun > 0) return   // bursting out of hitstun is handled in tick() (works through hitstop/freeze)

    advanceJumpSquat(f, inp)

    const leftTap  = taps.has("left")
    const rightTap = taps.has("right")
    const jumpTap  = taps.has("jump")

    // Slide-release countdown
    if (f.releaseFrames > 0) {
        f.releaseStep++
        if (f.releaseStep >= SLIDE_RELEASE_SPEEDS.length) {
            f.releaseFrames = 0
            const fn = f.releaseFn
            f.releaseFn = null
            if (fn) fn()
        } else {
            applySlideReleaseStep(f)
        }
        return
    }

    // Parry / dash / (flow)
    if (taps.has("parry")) {
        if ((FLOW_ENABLED) && f.shield >= f.shieldMax && opp.hitstun > 0 && !(g.witchTime.frames > 0)) {
            triggerWitchTime(f, opp, g)
        } else {
            const dv = getDashVec(inp)
            const started = startParry(f, opp, dv)
            if (started) {
                taps.delete("ultimate")
                if (!dv && opp.hitstun > 0) opp.hitstun += 15
            }
        }
    }

    if (f.grappleWindowFrames > 0) f.grappleWindowFrames--

    if (f.grapple) {
        if (jumpTap) {
            f.grapple = null
            const spd = Math.hypot(f.vx, f.vy)
            f.vy = -Math.min(spd, JUMP_POWER)
            f.doubleJump = false
        } else if (taps.has("ultimate")) {
            f.grapple = null
            taps.delete("ultimate")
        }
        return
    }

    // Grapple: ultimate tap during a parry dash (or just after one)
    if (taps.has("ultimate") && !f.grapple && f.hitstun <= 0) {
        if (f.parryDashFrames > 0 || f.grappleWindowFrames > 0) {
            taps.delete("ultimate")
            if (tryStartGrapple(f, opp)) return
        }
    }

    // Ultimate charge
    if (inp.held.ultimate && f.shield >= f.shieldMax && !f.ultimateActive && f.hitstun <= 0) {
        f.ultimateChargeFrames++
        if (f.ultimateChargeFrames >= f.ultimateMaxCharge) {
            if (f.characterName === "speedster") triggerJudgementCut(f, opp, g)
            else if (f.characterName === "ninja")  triggerShadowAssaultInitial(f, opp, g)
            f.ultimateChargeFrames = 0
        }
    } else {
        f.ultimateChargeFrames = 0
    }

    // Down tap while sliding along the underside of the stage → downward hyperjump
    if (taps.has("down") && f.underStageCeiling) {
        taps.delete("down")
        abortParryDash(f, false)
        const dvx = f.dashSurfaceExtended ? f.dashSurfaceExtendedFromVX : f.parryDashVX
        beginSlideRelease(f, () => {
            f.vx = Math.sign(dvx || f.facing) * PARRY_DASH_SPEED * 2.2
            f.vy = JUMP_POWER * 0.7
            f.underStageCeiling = false
            f.doubleJump = true
        })
    }

    f.platformDrop = f.parryDashFrames > 0 ? false : !!inp.held.down

    // Jump during a parry dash: hyperjump / wall bounce / plain cancel
    if (f.parryDashFrames > 0) {
        if (jumpTap) {
            const dvx = f.dashSurfaceExtended ? f.dashSurfaceExtendedFromVX : f.parryDashVX
            const dvy = f.dashSurfaceExtended ? f.dashSurfaceExtendedFromVY : f.parryDashVY
            const isDiagDown     = dvy > 1 && Math.abs(dvx) > 1
            const isDiagUpOrVert = dvy < -1

            if (f.onGround && isDiagDown) {
                abortParryDash(f, false)
                beginSlideRelease(f, () => {
                    f.vx = Math.sign(dvx) * PARRY_DASH_SPEED * 2.2
                    f.vy = -(JUMP_POWER * 0.7)
                    f.onGround = false
                    f.doubleJump = true
                })
            } else if (f.touchingWall !== 0 && isDiagUpOrVert) {
                abortParryDash(f, false)
                const wallDir = f.touchingWall
                beginSlideRelease(f, () => {
                    f.vx = -wallDir * PARRY_DASH_SPEED * 0.99
                    f.vy = -(JUMP_POWER * 1.5)
                    f.doubleJump = true
                    f.touchingWall = 0
                })
            } else {
                abortParryDash(f, true)
                if (f.onGround) startJumpSquat(f)
                else if (f.touchingWall !== 0) doJump(f, false)
                else if (f.doubleJump) doJump(f, false)
            }
        }
        return
    }

    // Air dash buffer
    if (!f.onGround) {
        if (leftTap && !rightTap)  { f.airDashBufferFrames = 10; f.airDashBufferDir = -1 }
        else if (rightTap && !leftTap) { f.airDashBufferFrames = 10; f.airDashBufferDir = 1 }
    }

    const attackLocked = f.attackLockFrames > 0
    let moveDir = (attackLocked && f.onGround) ? 0 : ((inp.held.left ? -1 : 0) + (inp.held.right ? 1 : 0))

    if (f.dashLockFrames > 0) {
        f.dashLockFrames--
        if (f.dashDir === 1  && moveDir === -1) moveDir = 0
        if (f.dashDir === -1 && moveDir === 1)  moveDir = 0
        if (f.dashDir === 1  && f.vx < 0) f.vx = 0
        if (f.dashDir === -1 && f.vx > 0) f.vx = 0
    } else { f.dashDir = 0 }

    const slow = f.witchTimeOwner ? WITCH_BOOST : 1

    // Ground dash buffer flush (air tap landed)
    if (f.onGround && f.airDashBufferFrames > 0) {
        const dir = f.airDashBufferDir
        if (dir !== 0 && Math.abs(f.vx) < DASH_THRESHOLD + 1) {
            f.vx = dir * DASH_SPEED; f.dashDir = dir
            f.dashLockFrames = 10; f.iFrames = 10; f.parryFrames = 10
            f.facing = dir
        }
        f.airDashBufferFrames = 0; f.airDashBufferDir = 0; moveDir = 0
    }

    f.moveInputDir = moveDir

    if (moveDir === -1) {
        if (f.onGround && leftTap && Math.abs(f.vx) < DASH_THRESHOLD) {
            f.vx = -DASH_SPEED; f.dashDir = -1; f.dashLockFrames = 12; f.iFrames = 8; f.parryFrames = 8
        } else { accelerateInput(f, -1, (f.onGround ? GROUND_ACCEL : AIR_ACCEL) * slow) }
        f.facing = -1
    } else if (moveDir === 1) {
        if (f.onGround && rightTap && Math.abs(f.vx) < DASH_THRESHOLD) {
            f.vx = DASH_SPEED; f.dashDir = 1; f.dashLockFrames = 12; f.iFrames = 8; f.parryFrames = 8
        } else { accelerateInput(f, 1, (f.onGround ? GROUND_ACCEL : AIR_ACCEL) * slow) }
        f.facing = 1
    }

    if (jumpTap && !attackLocked) {
        if (f.onGround) startJumpSquat(f)
        else if (f.touchingWall !== 0) doJump(f, false)
        else if (f.doubleJump)         doJump(f, false)
    }

    if (taps.has("attack") && f.attackCooldown <= 0 && !f.witchTimeVictim) {
        let dir = "neutral"
        if (inp.held.jump)                        dir = "up"
        else if (inp.held.down)                   dir = "down"
        else if (inp.held.left || inp.held.right) dir = "forward"
        if (f.jumpSquatFrames > 0) cancelJumpSquat(f)
        doAttack(f, dir, g)
    }

    if (taps.has("dash")) doSpecial(f, opp, g)
}

function getDashVec(inp) {
    const x = (inp.held.right ? 1 : 0) - (inp.held.left ? 1 : 0)
    const y = (inp.held.down  ? 1 : 0) - (inp.held.jump ? 1 : 0)
    if (x === 0 && y === 0) return null
    const mag = Math.hypot(x, y) || 1
    return { x: x / mag, y: y / mag }
}

// ─── Attack / special ─────────────────────────────────────────────────────────
function doAttack(f, direction, g) {
    if (f.attackCooldown > 0) return
    const m = getMoveset(f.characterName, direction, f.onGround)
    if (!m) return
    f.attackLockFrames = m.lockFrames
    f.attackCooldown   = m.cooldown
    for (const hd of m.hitboxes) {
        f.delayedHitboxes.push({ ...hd, frames: hd.delayFrames || 0 })
    }
    emit(g, "attackFx", {
        playerIdx: g.fighters.indexOf(f),
        direction,
        onGround: f.onGround,
        characterName: f.characterName
    })
}

function doSpecial(f, opp, g) {
    if (f.witchTimeVictim) return
    if (f.characterName === "speedster") dashTo(f, opp, g)
    else if (f.characterName === "mage")    doMageSpecial(f, opp, g)
    else if (f.characterName === "ninja")   doNinjaSpecial(f, opp, g)
}

function dashTo(f, opp, g) {
    if (f.dashCooldown > 0 || opp.hitstun <= 0) return
    f.dashCooldown = 150
    const sx = f.x + f.w / 2, sy = f.y + f.h / 2
    const ox = opp.x + opp.w / 2, oy = opp.y + opp.h / 2
    const dist = Math.hypot(ox - sx, oy - sy) || 1
    const ux = (ox - sx) / dist, uy = (oy - sy) / dist
    const OVERSHOOT = 150

    let arrivalX = ox + ux * OVERSHOOT
    let arrivalY = oy + uy * OVERSHOOT

    const DASH_MARGIN = 60
    arrivalX = Math.max(blast.left + DASH_MARGIN, Math.min(blast.right - DASH_MARGIN, arrivalX))
    arrivalY = Math.max(blast.top + DASH_MARGIN, Math.min(blast.bottom - DASH_MARGIN, arrivalY))

    let destX = arrivalX - f.w / 2
    let destY = arrivalY - f.h / 2
    for (const p of platforms) {
        if (p.topOnly) continue
        const overlapsX = destX + f.w > p.x && destX < p.x + p.w
        const overlapsY = destY + f.h > p.y && destY < p.y + p.h
        if (overlapsX && overlapsY) {
            if (Math.abs(ux) > Math.abs(uy)) {
                destX = ux > 0 ? p.x - f.w - 2 : p.x + p.w + 2
            } else {
                destY = uy > 0 ? p.y - f.h - 2 : p.y + p.h + 2
            }
            arrivalX = destX + f.w / 2
            arrivalY = destY + f.h / 2
            break
        }
    }

    f.x = destX
    f.y = destY
    f.vx = 0; f.vy = 0; f.doubleJump = true

    // Launch: tiny upward bias, same as the client
    const upBias = 0.05
    const biasedX = ux
    const biasedY = uy * (1 - upBias) + (-1) * upBias
    const biasedMag = Math.hypot(biasedX, biasedY) || 1
    const launchUX = biasedX / biasedMag
    const launchUY = biasedY / biasedMag - 0.1

    const dashKB = 16
    opp.vx = launchUX * dashKB; opp.vy = launchUY * dashKB
    opp.launchVelX = opp.vx; opp.launchVelY = opp.vy; opp.launchKB = dashKB
    opp.hitstun = 28; opp.percent += 4; opp.damageFlash = 6
    g.hitstopFrames = 21
    g.attackerFreezeFrames = Math.max(g.attackerFreezeFrames, 8)
    g.attackerFreezeIdx = g.fighters.indexOf(f)
    opp.freezeFrames = 2
    registerComboHit(f, opp, g)
    recordMove(f, "speedster-dashthrough")
    f.hitConfirmWindow = 8

    const rawDist = dist
    const SHORT_THRESHOLD = 40
    const SHOCK_SPACING   = 140
    if (rawDist > SHORT_THRESHOLD) {
        const shockCount = Math.max(1, Math.floor((rawDist - SHORT_THRESHOLD) / SHOCK_SPACING))
        const totalDX = arrivalX - sx
        const totalDY = arrivalY - sy
        for (let i = 0; i < shockCount; i++) {
            const t = (i + 1) / (shockCount + 1)
            schedule(g, Math.round((shockCount - i) * 3.6), "shockwave", {
                x: sx + totalDX * t, y: sy + totalDY * t, angle: Math.atan2(uy, ux), scale: 0.4 + t * 0.9
            })
        }
    }
}

function doMageSpecial(f, opp, g) {
    if (f.dashCooldown > 0) return
    f.dashCooldown = 150
    schedule(g, 0, "spawnRoot", { targetIdx: f === g.fighters[0] ? 1 : 0 })
}

function doNinjaSpecial(f, opp, g) {
    if (f.dashCooldown > 0 || opp.hitstun <= 0) return
    f.dashCooldown = 150
    schedule(g, 0, "spawnClone", { ownerIdx: f === g.fighters[0] ? 0 : 1 })
}

// ─── Combo helpers ────────────────────────────────────────────────────────────
function registerComboHit(attacker, defender, g) {
    const trueComboContinues = attacker.comboVictim === defender && defender.hitstun > 0
    if (trueComboContinues) {
        attacker.comboCount++
        if (g.witchTime.frames > 0 && attacker.witchTimeOwner) {
            const baseExtend = 15
            const comboBonus = Math.min(15, Math.floor(attacker.comboCount / 2))
            g.witchTime.frames = Math.min(WITCH_DURATION, g.witchTime.frames + baseExtend + comboBonus)
            attacker.freeParryDashCharges++
        }
    } else {
        attacker.comboCount = 1
        attacker.comboVictim = defender
    }
    // Combos of 3+ feed the attacker's meter (3→1, 4→2, 5→3 …)
    if (attacker.comboCount >= 3) gainMeter(attacker, attacker.comboCount, false)
}

function resetCombo(f) { f.comboCount = 0; f.comboVictim = null }

// ─── Parry / burst / witch-time ───────────────────────────────────────────────
function startParry(f, opp, dashVec) {
    const isFree = !!dashVec && f.freeParryDashCharges > 0
    if (!isFree && f.shield < PARRY_COST) return false
    if (isFree) f.freeParryDashCharges--
    else f.shield -= PARRY_COST
    f.parryFrames = PARRY_WINDOW
    if (dashVec) {
        f.parryDashFrames = PARRY_WINDOW
        f.parryDashStoredVX = f.vx; f.parryDashStoredVY = f.vy
        f.dashSurfaceExtended = false
        f.dashSurfaceExtendedFromVX = 0; f.dashSurfaceExtendedFromVY = 0
        f.parryDashVX = dashVec.x * PARRY_DASH_SPEED
        f.parryDashVY = dashVec.y * PARRY_DASH_SPEED
        f.vx = f.parryDashVX; f.vy = f.parryDashVY
        f.iFrames = Math.max(f.iFrames, PARRY_WINDOW)
        if (opp && opp.hitstun > 0) opp.hitstun += 15
        if (Math.abs(f.parryDashVX) > 0.01) f.facing = f.parryDashVX < 0 ? -1 : 1
    }
    return true
}

function finishParryDash(f) {
    if (f.parryDashStoredVX === null) return
    f.vx = f.parryDashVX * 0.8; f.vy = f.parryDashVY * 0.8
    f.parryDashFrames = 0; f.parryDashVX = 0; f.parryDashVY = 0
    f.parryDashStoredVX = null; f.parryDashStoredVY = null; f.parryFrames = 0
    f.grappleWindowFrames = 30
}

function abortParryDash(f, keepMomentum) {
    if (f.parryDashStoredVX === null) return
    if (keepMomentum) { f.vx = f.parryDashVX * PARRY_JUMP_BOOST; f.vy = f.parryDashVY }
    f.parryDashFrames = 0; f.parryFrames = 0; f.iFrames = 0
    f.parryDashVX = 0; f.parryDashVY = 0; f.parryDashStoredVX = null; f.parryDashStoredVY = null
    f.grappleWindowFrames = 30
}

// Burst: press parry while stunned. If the opponent's burst is incoming (windup or live wave)
// this arms a proactive burst-parry ("deflection") instead of starting a burst of your own.
function activateBurst(f, opp, g) {
    const oppIdx = g.fighters.indexOf(opp)
    const incomingBurst =
        g.pendingBursts.some(pb => pb.ownerIdx === oppIdx) ||
        g.burstWaves.some(w => w.ownerIdx === oppIdx && !w.hitTargets.has(f) && w.life > 0)

    if (f.hitstun > 0 && incomingBurst && f.shield >= BURST_PARRY_COST) {
        f.burstParryAttempted = true
        f.burstParryAttemptFrames = BURST_PARRY_ATTEMPT_FRAMES
        return true
    }

    if (f.shield < BURST_COST) return false
    if (f.hitstun <= 0) return false

    f.shield -= BURST_COST
    f.vx = 0; f.vy = 0; f.hitstun = 0
    f.burstHoverFrames = 15
    f.doubleJump = true

    g.pendingBursts.push({
        frames: BURST_WINDUP_FRAMES,
        x: f.x + f.w / 2,
        y: f.y + f.h / 2,
        ownerIdx: g.fighters.indexOf(f)
    })
    return true
}

function makeBurstWave(x, y, ownerIdx) {
    return {
        x, y, ownerIdx,
        radius: 20, maxRadius: 300, life: 40,
        hitTargets: new Set(),
        parriedBy: -1,
        freezeFrames: 0,
        imploding: false, implosionSpeed: 0,
        deflectNoticeShown: false
    }
}

function startWaveImplosion(w, g) {
    w.imploding = true
    w.implosionSpeed = w.radius / 9
    if (w.parriedBy !== -1 && !w.deflectNoticeShown) {
        w.deflectNoticeShown = true
        emit(g, "burstDeflectFx", { defenderIdx: w.parriedBy })
    }
}

function updateBurstWave(w, g) {
    if (w.freezeFrames > 0) {
        w.freezeFrames--
        if (w.freezeFrames === 0) startWaveImplosion(w, g)
        return
    }
    if (w.imploding) {
        w.radius -= w.implosionSpeed
        if (w.radius <= 0) { w.life = 0; return }
    } else {
        w.radius += (w.maxRadius - w.radius) * 0.2
    }
    w.life--

    const owner = g.fighters[w.ownerIdx]
    for (let ti = 0; ti < 2; ti++) {
        if (ti === w.ownerIdx) continue
        const target = g.fighters[ti]
        const dx = (target.x + target.w / 2) - w.x
        const dy = (target.y + target.h / 2) - w.y
        if (Math.sqrt(dx * dx + dy * dy) >= w.radius) continue
        if (w.hitTargets.has(target)) continue

        // Burst-parry ("deflection"): proactive attempt, or reactive window after the first hit
        if (target.burstParryWindow > 0 || target.burstParryAttempted) {
            if (target.shield >= BURST_PARRY_COST) {
                w.hitTargets.add(target)
                w.parriedBy = ti
                const parryDashing = target.parryDashFrames > 0

                target.shield -= BURST_PARRY_COST
                target.burstParryWindow = 0
                target.burstParryAttempted = false
                target.burstParryAttemptFrames = 0
                target.hitstun = 0
                if (!parryDashing) { target.vx = 0; target.vy = 0 }
                else { target.vx = target.parryDashVX; target.vy = target.parryDashVY }
                target.burstHoverFrames = 0

                owner.freezeFrames = 65
                owner.hitstun = 18
                owner.vx = 0; owner.vy = 0
                owner.burstHoverFrames = 0

                w.freezeFrames = 30
                emit(g, "parryFx", { x: target.x + target.w / 2, y: target.y + target.h / 2, defenderIdx: ti })
                emit(g, "burstDeflectFx", { defenderIdx: ti })
                w.deflectNoticeShown = true
                return
            }
        }

        // Regular parry
        if (target.parryFrames > 0) {
            w.hitTargets.add(target)
            w.parriedBy = ti
            const parryDashing = target.parryDashFrames > 0

            owner.freezeFrames = 60
            owner.vx = 0; owner.vy = 0
            owner.burstHoverFrames = 0

            if (!parryDashing) { target.vx = 0; target.vy = 0; target.parryFrames = 0 }
            else { target.vx = target.parryDashVX; target.vy = target.parryDashVY }

            target.shield = Math.min(target.shieldMax, target.shield + PARRY_REFUND)
            w.freezeFrames = 30
            emit(g, "parryFx", { x: target.x + target.w / 2, y: target.y + target.h / 2, defenderIdx: ti })
            return
        }

        if (target.iFrames > 0) continue

        // Hit
        w.hitTargets.add(target)
        target.hitboxes = []
        target.delayedHitboxes = []
        target.vx = 0; target.vy = 0
        target.hitstun = 20
        target.freezeFrames = 35
        target.doubleJump = true
        target.burstParryWindow = BURST_PARRY_WIN
        target.burstParryAttempted = false
        target.burstParryAttemptFrames = 0
        g.hitstopFrames = 12
    }
}

function triggerWitchTime(f, opp, g) {
    if (f.shield < f.shieldMax) return
    f.shield = 0; f.doubleJump = true
    const ownerIdx = g.fighters.indexOf(f)
    g.witchTime = { frames: WITCH_DURATION, ownerIdx, targetIdx: g.fighters.indexOf(opp) }
    f.witchTimeOwner = true; opp.witchTimeVictim = true
    f.flowEmpowered = true
    opp.hitboxes = []; opp.delayedHitboxes = []
    emit(g, "witchTimeFx", { ownerIdx })
}

function triggerJudgementCut(f, opp, g) {
    const dx = (opp.x + opp.w/2) - (f.x + f.w/2)
    const dy = (opp.y + opp.h/2) - (f.y + f.h/2)
    if (Math.abs(dx) >= JC_RANGE_X || Math.abs(dy) >= JC_RANGE_Y) return
    if (!((f.facing === 1 && dx > 0) || (f.facing === -1 && dx < 0))) return
    f.shield = Math.max(0, f.shield - f.shieldMax); f.ultimateActive = true
    f.freezeFrames = JC_TOTAL_FRAMES + 10; f.vx = 0; f.vy = 0
    opp.freezeFrames = JC_TOTAL_FRAMES + 10; opp.vx = 0; opp.vy = 0; opp.hitstun = 95
    g.hitstopFrames = JC_TOTAL_FRAMES
    // The cut flurry plays out client-side; the fixed-knockback final hit lands after it
    schedule(g, JC_TOTAL_FRAMES, "judgementCutFinal", {
        attackerIdx: g.fighters.indexOf(f),
        targetIdx:   g.fighters.indexOf(opp)
    })
}

function triggerShadowAssaultInitial(f, opp, g) {
    const dx = (opp.x + opp.w/2) - (f.x + f.w/2)
    const dy = (opp.y + opp.h/2) - (f.y + f.h/2)
    if (Math.abs(dx) >= 200 || Math.abs(dy) >= 150) return
    if (!((f.facing === 1 && dx > 0) || (f.facing === -1 && dx < 0))) return
    f.shield = Math.max(0, f.shield - f.shieldMax); f.ultimateActive = true
    f.x = opp.x + (f.facing > 0 ? opp.w + 20 : -f.w - 20); f.y = opp.y
    f.facing = -f.facing; f.vx = 0; f.vy = 0
    opp.vx = 0; opp.vy = -18; opp.hitstun = 200; opp.freezeFrames = 0
    g.hitstopFrames = 10
    schedule(g, 70, "shadowAssaultSlam", {
        attackerIdx: g.fighters.indexOf(f),
        targetIdx:   g.fighters.indexOf(opp)
    })
}

// ─── Hit detection ────────────────────────────────────────────────────────────
// Returns "parried" if the defender parried (caller stops scanning), otherwise undefined.
function resolveHitbox(attacker, defender, h, g) {
    const overlaps =
        h.x < defender.x + defender.w && h.x + h.w > defender.x &&
        h.y < defender.y + defender.h && h.y + h.h > defender.y
    if (!overlaps) return

    // Parry
    if (defender.parryFrames > 0) {
        attacker.freezeFrames = 20; attacker.vx = 0; attacker.vy = 0
        attacker.hitboxes = []
        if (defender.parryDashFrames > 0) { defender.vx = defender.parryDashVX; defender.vy = defender.parryDashVY }
        else { defender.vx = 0; defender.vy = 0; defender.parryFrames = 0 }
        defender.shield = Math.min(defender.shieldMax, defender.shield + PARRY_REFUND)
        emit(g, "parryFx", { x: defender.x + defender.w/2, y: defender.y + defender.h/2, defenderIdx: g.fighters.indexOf(defender) })
        return "parried"
    }

    if (defender.iFrames > 0) return
    if (h.hitTargets.has(defender)) return

    const moveTag = h.moveTag || "generic"
    const attackerIdx = g.fighters.indexOf(attacker)

    // ── Neutral drag-down (carries the defender along with the attacker's momentum) ──
    if (moveTag === "speedster-neutral-dragdown") {
        const mag = Math.hypot(attacker.vx, attacker.vy)
        defender.vx = attacker.vx * 0.6
        defender.vy = (Math.tanh(attacker.vy / 15) * 15 - 2.5) * 0.8
        defender.launchKB = mag
        defender.percent += h.damage
        gainMeter(defender, Math.floor(h.damage) * HIT_METER_GAIN_SCALE, true)
        attacker.hitConfirmWindow = 6
        attacker.hitfallQueued = false
        defender.damageFlash = 2
        defender.hitstun = NEUTRAL_DRAG_HITSTUN
        defender.hitboxes = []; defender.delayedHitboxes = []
        defender.freezeFrames = 0
        recordMove(attacker, moveTag)
        registerComboHit(attacker, defender, g)
        h.hitTargets.add(defender)
        if (!h.multihit) h.frames = 0
        g.hitstopFrames = Math.max(g.hitstopFrames, 4 + Math.min(4, h.damage * 0.25))
        emit(g, "hitFx", { x: defender.x + defender.w/2, y: defender.y + defender.h/2, kb: mag, isDrag: true, attackerIdx })
        return
    }

    // ── Normal hit ──
    const stale = getStaleFactor(attacker, moveTag)
    const staleHitstunFactor = Math.max(0, stale + 0.05)
    const hasFixedKb = h.fixedKb !== null && h.fixedKb !== undefined

    const rawKb = hasFixedKb ? h.fixedKb : h.kb + Math.pow(defender.percent, 1.5) * KB_PERCENT_SCALE + 14
    let   kb    = hasFixedKb ? h.fixedKb : rawKb * ((stale + 2) / 3)
    const launchAngle = h.angle * Math.PI / 180

    const cr = hasFixedKb ? { multiplier: 1, isCounter: false } : counterVelocityBonus(defender, h.angle, attacker.facing)
    const rawDamage = h.damage * cr.multiplier
    const dmgHitstop = Math.min(10, rawDamage)

    if (!hasFixedKb) {
        if (defender.percent >= 100) kb *= 1.6
        kb *= 1 + (cr.multiplier - 1) * 0.2
    }

    const baseHitstun = (h.fixedHitstun !== null && h.fixedHitstun !== undefined)
        ? h.fixedHitstun
        : computeBaseHitstun(rawKb, launchAngle, staleHitstunFactor, attacker)

    // Kill prediction decides whether this hit gets the long kill-cam hitstop
    const lethal = predictKillHit(defender, attacker, kb, launchAngle, baseHitstun, g)

    if (lethal) {
        g.hitstopFrames = 35 + dmgHitstop
    } else {
        const upness = Math.max(0, Math.sin(launchAngle))
        const hsm    = 1 - upness * 0.3
        const total  = Math.max(g.hitstopFrames, 4 + kb * hsm * 0.6 + dmgHitstop)
        const sharedPortion = Math.ceil(total * (1 - HIT_ATTACKER_FREE_SHARE))
        const freePortion   = Math.floor(total * HIT_ATTACKER_FREE_SHARE)
        g.hitstopFrames        = Math.max(g.hitstopFrames, sharedPortion)
        g.attackerFreezeFrames = Math.max(g.attackerFreezeFrames, freePortion)
        g.attackerFreezeIdx    = attackerIdx
    }

    const launchX = Math.cos(launchAngle) * kb * attacker.facing
    const launchY = -Math.sin(launchAngle) * kb

    defender.pendingLaunch = { baseVx: launchX, baseVy: launchY, baseSpeed: kb, hitstun: Math.max(0, baseHitstun) }
    defender.vx = launchX; defender.vy = launchY
    defender.launchVelX = launchX; defender.launchVelY = launchY; defender.launchKB = kb
    defender.hitstun  = Math.max(0, baseHitstun)
    defender.percent += rawDamage
    gainMeter(defender, Math.floor(rawDamage) * HIT_METER_GAIN_SCALE, true)
    defender.damageFlash = 2
    defender.hitboxes = []; defender.delayedHitboxes = []
    defender.freezeFrames = 0
    attacker.hitConfirmWindow = 6
    attacker.hitfallQueued = false
    registerComboHit(attacker, defender, g)
    recordMove(attacker, moveTag)

    h.hitTargets.add(defender)
    if (!h.multihit) h.frames = 0

    emit(g, "hitFx", {
        x: defender.x + defender.w/2, y: defender.y + defender.h/2,
        kb, angle: h.angle, attackerFacing: attacker.facing,
        isCounter: cr.isCounter, isKill: lethal,
        attackerIdx,
        effectiveDamage: rawDamage,
        comboCount: attacker.comboCount
    })
}

function runHitDetection(attacker, defender, g) {
    for (const h of attacker.hitboxes) {
        if (!h.active()) continue
        if (resolveHitbox(attacker, defender, h, g) === "parried") return
    }
}

// ─── DI resolution ────────────────────────────────────────────────────────────
function resolveDI(f, inp) {
    if (!f.pendingLaunch) return
    const p  = f.pendingLaunch
    const ix = (inp.held.right ? 1 : 0) - (inp.held.left ? 1 : 0)
    const iy = (inp.held.down  ? 1 : 0) - (inp.held.jump ? 1 : 0)
    let input = null
    if (ix !== 0 || iy !== 0) {
        const mag = Math.hypot(ix, iy) || 1
        input = { x: ix / mag, y: iy / mag }
    }
    const di = applyLaunchDI(p.baseVx, p.baseVy, p.baseSpeed, input)
    f.vx = di.vx; f.vy = di.vy
    f.launchVelX = di.vx; f.launchVelY = di.vy
    f.launchKB   = Math.hypot(di.vx, di.vy)
    f.hitstun    = p.hitstun
    f.pendingLaunch = null
}

// ─── Blast zone / respawn ─────────────────────────────────────────────────────
function checkBlast(f, g) {
    const idx = g.fighters.indexOf(f)
    const extraMargin = 200
    const bL = f.hitstun > 0 ? blast.left   : blast.left   - extraMargin
    const bR = f.hitstun > 0 ? blast.right  : blast.right  + extraMargin
    const bT = f.hitstun > 0 ? blast.top    : blast.top    - extraMargin
    const bB = f.hitstun > 0 ? blast.bottom : blast.bottom + extraMargin
    if (f.x >= bL && f.x <= bR && f.y >= bT && f.y <= bB) return
    if (g.gameOver) return

    f.percent = 0; f.trailingPercent = 0; f.stocks--
    resetCombo(f)
    emit(g, "blastFx", { x: Math.max(-300, Math.min(CANVAS_W + 300, f.x + f.w/2)), y: Math.max(-300, Math.min(CANVAS_H + 300, f.y + f.h/2)) })

    if (f.stocks <= 0) {
        g.gameOver  = true
        g.winnerIdx = 1 - idx
        f.x = -9999; f.y = -9999; f.vx = 0; f.vy = 0; f.hitstun = 0; f.freezeFrames = 999
        return
    }

    const sp = spawnPoints[idx]
    f.x = sp.x; f.y = sp.y; f.vx = 0; f.vy = 0; f.hitstun = 0; f.freezeFrames = 0
    f.pendingLaunch = null; f.flashEffects = []; f.damageFlash = 0
    f.touchingWall = 0; f.platformDrop = false
    f.burstHoverFrames = 0; f.burstParryWindow = 0
    f.burstParryAttempted = false; f.burstParryAttemptFrames = 0
    f.parryDashFrames = 0; f.parryDashVX = 0; f.parryDashVY = 0
    f.parryDashStoredVX = null; f.parryDashStoredVY = null; f.freeParryDashCharges = 0
    f.dashSurfaceExtended = false
    f.dashSurfaceExtendedFromVX = 0; f.dashSurfaceExtendedFromVY = 0
    f.underStageCeiling = false
    f.grapple = null; f.grappleWindowFrames = 0
    f.releaseFrames = 0; f.releaseFn = null
}

// ─── Per-fighter update (client: Fighter.update) ─────────────────────────────
function updateFighter(f, idx, inp, g) {
    if (f.hitstun > 0 && f.releaseFrames > 0) { f.releaseFrames = 0; f.releaseFn = null }

    if (f.freezeFrames > 0) { f.freezeFrames--; return }

    // Soft homing for the Flow owner while airborne
    if (f.witchTimeOwner && !f.onGround) {
        const opp = g.fighters[1 - idx]
        const dx = (opp.x + opp.w/2) - (f.x + f.w/2)
        const dy = (opp.y + opp.h/2) - (f.y + f.h/2)
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        f.vx += (dx / dist) * 0.1
        f.vy += (dy / dist) * 0.1
    }

    // Hit-confirm hitfall window
    if (f.hitConfirmWindow > 0) {
        f.hitConfirmWindow--
        if (inp.taps.has("down") && !f.onGround && f.touchingWall === 0 && f.hitstun <= 0) {
            f.hitfallQueued = true
            inp.taps.delete("down")
            const opp = g.fighters[1 - idx]
            if (opp && opp.hitstun > 0) opp.hitstun += 10
        }
    }

    if (f.burstParryWindow > 0) f.burstParryWindow--
    if (f.burstParryAttempted) {
        f.burstParryAttemptFrames--
        if (f.burstParryAttemptFrames <= 0) f.burstParryAttempted = false
    }
    if (f.parryFrames > 0) f.parryFrames--
    if (f.parryDashFrames > 0) { f.parryDashFrames--; if (f.parryDashFrames <= 0) finishParryDash(f) }

    // Shield regen
    if (f.shield < f.shieldMax && f.parryFrames <= 0) {
        const s1 = f.shieldMax / 3, s2 = f.shieldMax * 2 / 3
        const rm = f.shield <= s1 ? REGEN_MULT_LOW : f.shield <= s2 ? REGEN_MULT_MID : REGEN_MULT_HIGH
        f.shield = Math.min(f.shieldMax, f.shield + SHIELD_REGEN * rm * depthRegenMultiplier(f))
    }

    if (f.hitstun > 0) { f.hitstun--; f.vy += GRAVITY * (HIT_FALL_MULT - 1) }

    if (f.hitstun <= 0 && f.trailingPercent < f.percent) {
        f.trailingPercent = Math.min(f.percent, f.trailingPercent + 2.2)
    }

    if (f.attackCooldown > 0) f.attackCooldown -= (f.witchTimeOwner ? WITCH_ATK_BOOST : 1)
    if (f.attackLockFrames > 0) f.attackLockFrames--
    if (f.dashCooldown > 0)     f.dashCooldown--
    if (f.airDashBufferFrames > 0) f.airDashBufferFrames--

    // Delayed hitboxes
    for (let i = f.delayedHitboxes.length - 1; i >= 0; i--) {
        const dh = f.delayedHitboxes[i]
        dh.frames--
        if (dh.frames <= 0) {
            f.hitboxes.push(new SHitbox(f, dh.offsetX, dh.offsetY, dh.w, dh.h, dh.damage, dh.angle, dh.kb, dh.multihit, dh.moveTag))
            f.delayedHitboxes.splice(i, 1)
        }
    }

    applyPhysics(f, inp, g)

    for (const h of f.hitboxes) h.update()
    f.hitboxes = f.hitboxes.filter(h => h.active())

    if (f.damageFlash > 0) f.damageFlash--

    if (f.comboCount > 0 && (!f.comboVictim || f.comboVictim.hitstun <= 0)) resetCombo(f)
}

// ─── Events that fire after a delay ──────────────────────────────────────────
function applyPendingEvent(ev, g) {
    if (ev.type === "judgementCutDamage") {   // legacy name, kept for older clients
        return
    }

    if (ev.type === "judgementCutFinal") {
        const atk = g.fighters[ev.data.attackerIdx]
        const tgt = g.fighters[ev.data.targetIdx]
        if (!atk || !tgt || g.gameOver) return
        atk.freezeFrames = 0
        tgt.freezeFrames = 0
        g.hitstopFrames = 0
        tgt.hitstun = 0
        // Real hitbox with a constant launch, no percent scaling
        const hb = new SHitbox(atk, 0, 0, tgt.w + 40, tgt.h + 40, JC_FINAL_DAMAGE, JC_FINAL_ANGLE, JC_FINAL_KB, false, "judgementCut")
        hb.fixedKb = JC_FINAL_KB
        hb.fixedHitstun = JC_FINAL_HITSTUN
        hb.x = tgt.x + tgt.w / 2 - hb.w / 2
        hb.y = tgt.y + tgt.h / 2 - hb.h / 2
        atk.hitboxes.push(hb)
        resolveHitbox(atk, tgt, hb, g)
        g.hitstopFrames = Math.max(g.hitstopFrames, 30)
        atk.ultimateActive = false
        // The hit sets DI-able launch; resolve it when the hitstop ends like any other hit
        return
    }

    if (ev.type === "shadowAssaultSlam") {
        const atk = g.fighters[ev.data.attackerIdx]
        const tgt = g.fighters[ev.data.targetIdx]
        tgt.percent += 12
        tgt.vx = Math.cos(Math.PI * 1.4) * 18 * atk.facing
        tgt.vy = -Math.sin(Math.PI * 1.4) * 18
        tgt.hitstun = 50
        atk.ultimateActive = false
        atk.vx = -atk.facing * 10; atk.vy = -8
    }
}

// ─── Burst windup / waves ────────────────────────────────────────────────────
function updateBursts(g) {
    for (let i = g.pendingBursts.length - 1; i >= 0; i--) {
        const pb = g.pendingBursts[i]
        pb.frames--
        if (pb.frames <= 0) {
            g.burstWaves.push(makeBurstWave(pb.x, pb.y, pb.ownerIdx))
            emit(g, "burstWave", { ownerIdx: pb.ownerIdx, x: pb.x, y: pb.y })
            g.pendingBursts.splice(i, 1)
        }
    }
    for (let i = g.burstWaves.length - 1; i >= 0; i--) {
        const w = g.burstWaves[i]
        updateBurstWave(w, g)
        if (w.life <= 0) g.burstWaves.splice(i, 1)
    }
}

// ─── Serialise state for clients ─────────────────────────────────────────────
// 3 decimals is far below anything visible (positions) or gameplay-relevant (percent/meter) and cuts the packet ~40%.
const q = v => Math.round(v * 1000) / 1000

function buildStateObject(g) {
    const fighters = g.fighters.map(f => ({
        x: q(f.x), y: q(f.y), vx: q(f.vx), vy: q(f.vy),
        facing: f.facing, onGround: f.onGround,
        hitstun: f.hitstun, percent: q(f.percent),
        stocks: f.stocks, shield: q(f.shield),
        dashCooldown: f.dashCooldown,
        burstHoverFrames: f.burstHoverFrames,
        freezeFrames: f.freezeFrames,
        damageFlash: f.damageFlash,
        hitConfirmWindow: f.hitConfirmWindow,
        witchTimeOwner: f.witchTimeOwner,
        witchTimeVictim: f.witchTimeVictim,
        parryFrames: f.parryFrames,
        ultimateActive: f.ultimateActive,
        launchKB: q(f.launchKB),
        trailingPercent: q(f.trailingPercent),
        attackLockFrames: f.attackLockFrames,
        comboCount: f.comboCount,
        // extra fields (older clients ignore these)
        parryDashFrames: f.parryDashFrames,
        parryDashVX: q(f.parryDashVX),
        parryDashVY: q(f.parryDashVY),
        burstParryWindow: f.burstParryWindow,
        burstParryAttempted: f.burstParryAttempted,
        underStageCeiling: f.underStageCeiling,
        grapple: f.grapple ? { anchorX: f.grapple.anchorX, anchorY: f.grapple.anchorY, radius: f.grapple.radius } : null
    }))

    return {
        type: "state",
        frame: g.frame,
        fighters,
        witchTime: g.witchTime,
        hitstopFrames: g.hitstopFrames,
        gameOver: g.gameOver,
        winnerIdx: g.winnerIdx,
        vfxEvents: g.vfxOut
    }
}

function buildStatePacket(g) { return JSON.stringify(buildStateObject(g)) }

// ─── Main tick ────────────────────────────────────────────────────────────────
function tick(g, inputs) {
    if (g.gameOver) return
    G = g
    g.frame++
    g.vfxOut = []
    g.controlsRan[0] = g.controlsRan[1] = false

    const [f0, f1] = g.fighters
    const inp      = [inputs[0], inputs[1]]
    const taps     = [inputs[0].taps, inputs[1].taps]

    // Witch time bookkeeping
    if (g.witchTime.frames > 0) {
        g.witchTime.frames--
        if (g.witchTime.frames <= 0) {
            f0.witchTimeOwner = false; f0.witchTimeVictim = false
            f1.witchTimeOwner = false; f1.witchTimeVictim = false
            f0.flowEmpowered = false;  f1.flowEmpowered = false
            g.witchTime = { frames: 0, ownerIdx: -1, targetIdx: -1 }
        }
    }

    // Delayed events whose frame has arrived (mutate state, then forward to clients)
    g.pendingEvents = g.pendingEvents.filter(ev => {
        if (ev.applyAtFrame > g.frame) return true
        applyPendingEvent(ev, g)
        g.vfxOut.push({ type: ev.type, data: ev.data })
        return false
    })

    // iFrames tick down every frame, hitstop or not
    for (const f of g.fighters) if (f.iFrames > 0) f.iFrames--

    if (g.hitstopFrames <= 0 && g.attackerFreezeFrames <= 0) {
        // Normal tick — controls for both, then update both, then hit detection
        for (let i = 0; i < 2; i++) processControls(g.fighters[i], g.fighters[1 - i], inp[i], taps[i], g)
        g.controlsRan[0] = g.controlsRan[1] = true
        for (let i = 0; i < 2; i++) {
            updateFighter(g.fighters[i], i, inp[i], g)
            if (g.gameOver) break
        }
        if (!g.gameOver) {
            runHitDetection(f0, f1, g)
            runHitDetection(f1, f0, g)
        }
    } else if (g.attackerFreezeFrames > 0 && g.hitstopFrames <= 0) {
        // Attacker's "free" window — only the attacker can act, defender stays frozen
        g.attackerFreezeFrames--
        const ai  = g.attackerFreezeIdx
        const atk = g.fighters[ai]
        const def = g.fighters[1 - ai]
        processControls(atk, def, inp[ai], taps[ai], g)
        g.controlsRan[ai] = true
        updateFighter(atk, ai, inp[ai], g)

        if (g.attackerFreezeFrames <= 0) {
            g.attackerFreezeFrames = 0
            g.attackerFreezeIdx = -1
            resolveDI(f0, inp[0])
            resolveDI(f1, inp[1])
        }
        if (!g.gameOver) {
            runHitDetection(f0, f1, g)
            runHitDetection(f1, f0, g)
        }
    } else {
        g.hitstopFrames--
        if (g.hitstopFrames <= 0) {
            g.hitstopFrames = 0
            if (g.attackerFreezeFrames <= 0) {
                resolveDI(f0, inp[0])
                resolveDI(f1, inp[1])
            }
        }
    }

    // Burst input — runs every frame (through hitstop / freeze), stunned fighters only
    for (let i = 0; i < 2; i++) {
        const f = g.fighters[i]
        if (f.hitstun > 0 && taps[i].has("parry")) {
            activateBurst(f, g.fighters[1 - i], g)
            taps[i].delete("parry")
        }
    }

    updateBursts(g)
}
// ─── Utilities ────────────────────────────────────────────────────────────────
function blankInput() {
    return {
        held: { left:false,right:false,jump:false,down:false,attack:false,dash:false,parry:false,ultimate:false },
        taps: new Set(),
        tapAge: new Map()   // action -> ticks the tap has been waiting (only grows while controls are frozen out)
    }
}

// After a tick: if the fighter's controls ran, their taps were seen -> clear. If not (hitstop, freeze, the
// defender during the attacker's free window) the press would be lost, so keep it for a few ticks like the
// client's own input buffer does. Stale taps are dropped.
function endTickTaps(inp, controlsRan) {
    if (controlsRan) { inp.taps.clear(); inp.tapAge.clear(); return }
    for (const a of [...inp.taps]) {
        const age = (inp.tapAge.get(a) || 0) + 1
        if (age >= TAP_BUFFER_TICKS) { inp.taps.delete(a); inp.tapAge.delete(a) }
        else inp.tapAge.set(a, age)
    }
}

// ==SIM_END==

// ─── Client-side prediction support (shadow mode) ────────────────────────────
// A client that sends {type:"netopt", shadow:true} gets a `pred` block in its snapshots:
//   ack  = ct of the newest input message applied (the client's own tick counter when it sent it)
//   at   = the server tick that message was applied on  -> the client works out the tick offset from (at - ct)
//   ok   = the fighter is in a state the client can simulate on its own (no hit-stun, freeze, attack boxes, ...)
//   full = every fighter field that differs from a fresh fighter, so the client can rebuild the exact state
function predictable(f, g) {
    return f.hitstun <= 0 && f.freezeFrames <= 0 && g.hitstopFrames <= 0 && g.attackerFreezeFrames <= 0 &&
           !f.releaseFn && !f.pendingLaunch && !f.grapple && f.hitboxes.length === 0 && f.delayedHitboxes.length === 0 &&
           !f.ultimateActive && f.burstHoverFrames <= 0 && f.parryDashFrames <= 0 && g.witchTime.frames <= 0 &&
           g.pendingBursts.length === 0
}

function diffFighter(f, idx) {
    const base = makeFighter(idx, f.characterName)
    const out = {}
    for (const k of Object.keys(f)) {
        const v = f[k], b = base[k]
        if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
            if (v !== b) out[k] = v
        } else if (Array.isArray(v)) {
            if (v.length && v.every(e => typeof e === "string" || typeof e === "number")) out[k] = v
        }
    }
    return out
}

function buildPred(g, idx, inp) {
    const f  = g.fighters[idx]
    const ok = predictable(f, g)
    const pred = { ack: inp.ackCt === undefined ? -1 : inp.ackCt, at: inp.ackTick || 0,
                   ch: inp.chCt === undefined ? -1 : inp.chCt, chAt: inp.chTick || 0, ok }
    if (ok) pred.full = diffFighter(f, idx)
    return pred
}

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    let code = ""
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]
    return code
}

function broadcastLobby() {
    const list = [...rooms.values()]
        .filter(r => r.public)
        .map(r => ({
            code:       r.code,
            players:    r.players.length,
            spectators: r.spectators.length,
            inGame:     r.inGame
        }))
    const pkt = JSON.stringify({ type: "roomList", rooms: list })
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c._inLobby) c.send(pkt)
    })
}

function sendToSocket(socket, obj) {
    if (socket && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(obj))
}

// ─── Room state ───────────────────────────────────────────────────────────────
//
// Room = {
//   code, public,
//   players:    [ { socket, charIdx, colorIdx, ready } ],   max 2
//   spectators: [ socket ],                                  max 4
//   inGame:     bool,
//   session:    Session | null
// }
//
// Session = { inputs, game, interval }

const rooms = new Map()          // code → Room

// ─── Session helpers ──────────────────────────────────────────────────────────

// Drift-free 60 Hz scheduler. setInterval(…, 1000/60) fires at 16/17 ms and drifts, which shows up as
// uneven snapshot spacing (= visible jitter). Here every tick has an absolute deadline (next += TICK_MS),
// a coarse setTimeout waits most of the way and setImmediate finishes the last ~1 ms. If the process
// stalls, up to MAX_CATCHUP_TICKS ticks run back-to-back, then the schedule resyncs instead of spiralling.
function startTickLoop(onTick, stats) {
    let next = performance.now() + TICK_MS
    let timer = null, isImmediate = false, stopped = false

    const step = () => {
        timer = null
        if (stopped) return
        let now = performance.now()
        let ran = 0
        while (now >= next && !stopped) {
            if (stats) stats.late = Math.max(stats.late, now - next)
            const t0 = now
            onTick()
            now = performance.now()
            if (stats) stats.cost = Math.max(stats.cost, now - t0)
            next += TICK_MS
            if (++ran >= MAX_CATCHUP_TICKS && now >= next) { next = now + TICK_MS; if (stats) stats.resyncs++; break }
        }
        if (stopped) return
        const wait = next - performance.now()
        if (wait > SPIN_MS + 1) { isImmediate = false; timer = setTimeout(step, wait - SPIN_MS) }
        else                    { isImmediate = true;  timer = setImmediate(step) }
    }

    isImmediate = false
    timer = setTimeout(step, TICK_MS)
    return () => {
        stopped = true
        if (timer) { isImmediate ? clearImmediate(timer) : clearTimeout(timer); timer = null }
    }
}

// Snapshots are full state, so a slow client is better served by skipping one than by queueing it behind
// the others (that is how latency silently grows to seconds). The skipped snapshot's one-shot VFX events
// are carried over so hits/parries never go missing. The final (gameOver) snapshot always goes out.
function sendState(sock, obj, json, force) {
    if (!sock || sock.readyState !== WebSocket.OPEN) return
    if (!force && sock.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (obj.vfxEvents.length) {
            if (!sock._carryVfx) sock._carryVfx = []
            for (const ev of obj.vfxEvents) sock._carryVfx.push(ev)
            if (sock._carryVfx.length > 200) sock._carryVfx.splice(0, sock._carryVfx.length - 200)
        }
        return
    }
    if (sock._carryVfx && sock._carryVfx.length) {
        const merged = Object.assign({}, obj, { vfxEvents: sock._carryVfx.concat(obj.vfxEvents) })
        sock._carryVfx = null
        sock.send(JSON.stringify(merged))
        return
    }
    sock.send(json)
}

function startRoomSession(room) {
    room.inGame = true
    const characters = room.players.map(p => {
        const names = ["speedster","mage","ninja"]
        return names[p.charIdx] || "speedster"
    })
    const stats = { late: 0, cost: 0, resyncs: 0 }
    const session = {
        inputs:   [blankInput(), blankInput()],
        game:     makeGame(characters),
        stop:     null
    }
    room.session = session

    const onTick = () => {
        const g = session.game
        tick(g, session.inputs)
        for (let i = 0; i < 2; i++) endTickTaps(session.inputs[i], g.controlsRan[i])

        const obj  = buildStateObject(g)
        const json = JSON.stringify(obj)
        const force = g.gameOver
        room.players.forEach((p, i) => {
            if (p.socket && p.socket._shadow) {
                const o = Object.assign({}, obj, { pred: buildPred(g, i, session.inputs[i]) })
                sendState(p.socket, o, JSON.stringify(o), force)
            } else sendState(p.socket, obj, json, force)
        })
        room.spectators.forEach(s => sendState(s, obj, json, force))

        if (g.gameOver) {
            session.stop()
            room.inGame = false
            setTimeout(() => closeRoom(room.code), 5000)
        }
    }

    session.stop = startTickLoop(onTick, stats)

    if (NET_DEBUG) {
        const dbg = setInterval(() => {
            if (!room.session || room.session !== session || !room.inGame) { clearInterval(dbg); return }
            console.log(`[net ${room.code}] worst tick lateness ${stats.late.toFixed(2)} ms, worst tick cost ${stats.cost.toFixed(2)} ms, resyncs ${stats.resyncs}`)
            stats.late = 0; stats.cost = 0
        }, 5000)
    }
}

function closeRoom(code) {
    const room = rooms.get(code)
    if (!room) return
    if (room.session && room.session.stop) {
        room.session.stop()
        room.session.stop = null
    }
    // Notify everyone
    room.players.forEach(p => { if (p.socket) sendToSocket(p.socket, { type: "roomClosed" }) })
    room.spectators.forEach(s => sendToSocket(s, { type: "roomClosed" }))
    rooms.delete(code)
    broadcastLobby()
    console.log(`Room ${code} closed`)
}

// ─── Connection handler ───────────────────────────────────────────────────────
wss.on("connection", socket => {
    console.log("Client connected")
    if (socket._socket && socket._socket.setNoDelay) socket._socket.setNoDelay(true)   // never let Nagle hold a packet back
    socket._alive     = true
    socket.on("pong", () => { socket._alive = true })
    socket._inLobby   = false
    socket._roomCode  = null
    socket._playerIdx = -1
    socket._spectator = false

    socket.on("message", rawMsg => {
        let data
        try { data = JSON.parse(rawMsg) } catch(e) { return }
        handleClientMessage(socket, data)
    })

    socket.on("close", () => handleDisconnect(socket))
})

function handleClientMessage(socket, data) {
    switch (data.type) {

    // ── Lobby browsing ──────────────────────────────────────────────────
    case "listRooms": {
        socket._inLobby = true
        const list = [...rooms.values()]
            .filter(r => r.public)
            .map(r => ({
                code:       r.code,
                players:    r.players.length,
                spectators: r.spectators.length,
                inGame:     r.inGame
            }))
        sendToSocket(socket, { type: "roomList", rooms: list })
        break
    }

    // ── Create room ─────────────────────────────────────────────────────
    case "createRoom": {
        let code = generateRoomCode()
        while (rooms.has(code)) code = generateRoomCode()

        const room = {
            code, public: true,
            players:    [{ socket, charIdx: 0, colorIdx: 0, ready: false }],
            spectators: [],
            inGame:     false,
            session:    null
        }
        rooms.set(code, room)
        socket._inLobby  = false
        socket._roomCode = code
        socket._playerIdx = 0

        sendToSocket(socket, { type: "roomCreated", code })
        sendToSocket(socket, { type: "roomJoined",  playerIdx: 0 })
        broadcastLobby()
        console.log(`Room ${code} created`)
        break
    }

    // ── Join room ───────────────────────────────────────────────────────
    case "joinRoom": {
        const room = rooms.get(data.code)
        if (!room) { sendToSocket(socket, { type: "roomError", message: "Room not found." }); break }
        if (room.players.length >= 2) { sendToSocket(socket, { type: "roomError", message: "Room is full." }); break }
        if (room.inGame) { sendToSocket(socket, { type: "roomError", message: "Game already in progress." }); break }

        room.players.push({ socket, charIdx: 2, colorIdx: 1, ready: false })
        socket._inLobby   = false
        socket._roomCode  = data.code
        socket._playerIdx = 1

        sendToSocket(socket, { type: "roomJoined", playerIdx: 1 })
        broadcastLobby()
        console.log(`Player joined room ${data.code}`)
        break
    }

    // ── Spectate room ───────────────────────────────────────────────────
    case "spectateRoom": {
        const room = rooms.get(data.code)
        if (!room) { sendToSocket(socket, { type: "roomError", message: "Room not found." }); break }
        if (room.spectators.length >= 4) { sendToSocket(socket, { type: "roomError", message: "Spectator seats full." }); break }

        room.spectators.push(socket)
        socket._inLobby   = false
        socket._roomCode  = data.code
        socket._spectator = true

        sendToSocket(socket, { type: "spectateJoined", code: data.code })
        console.log(`Spectator joined room ${data.code}`)
        break
    }

    // ── Latency probe (answered immediately, not tick-aligned) ──────────
    case "ping": {
        if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"pong","t":' + (+data.t || 0) + '}')
        break
    }

    // ── Per-connection options (prediction shadow mode) ─────────────────
    case "netopt": {
        socket._shadow = !!data.shadow
        break
    }

    // ── Close own room ──────────────────────────────────────────────────
    case "closeRoom": {
        if (socket._roomCode) closeRoom(socket._roomCode)
        break
    }

    // ── Character select ready ──────────────────────────────────────────
    case "csReady": {
        const room = rooms.get(socket._roomCode)
        if (!room) break
        const idx = socket._playerIdx
        if (idx < 0 || idx > 1) break

        room.players[idx].charIdx  = data.charIdx  ?? room.players[idx].charIdx
        room.players[idx].colorIdx = data.colorIdx ?? room.players[idx].colorIdx
        room.players[idx].ready    = !!data.ready

        const other = room.players[1 - idx]
        if (other && other.socket) {
            sendToSocket(other.socket, {
                type:     "opponentCharReady",
                charIdx:  room.players[idx].charIdx,
                colorIdx: room.players[idx].colorIdx,
                ready:    room.players[idx].ready
            })
        }

        if (room.players.length === 2 &&
            room.players[0].ready &&
            room.players[1].ready &&
            !room.inGame) {
            startRoomSession(room)
        }
        break
    }

    // ── In-game input ───────────────────────────────────────────────────
    case "input": {
        const room = rooms.get(socket._roomCode)
        if (!room || !room.session) break
        const idx = socket._playerIdx
        if (idx < 0 || idx > 1) break

        const inp = room.session.inputs[idx]
        if (typeof data.ct === "number") {
            inp.ackCt = data.ct; inp.ackTick = room.session.game.frame + 1   // applied on the next tick
            // Is this a real change (a press, a release, a tap) or just a keep-alive? The client lines its timeline up
            // against the last real change, because only a change can arrive "late" in a way that matters.
            let changed = Array.isArray(data.taps) && data.taps.length > 0
            if (!changed && data.held && typeof data.held === "object") {
                for (const a of NET_ACTIONS) if (!!data.held[a] !== !!inp.held[a]) { changed = true; break }
            }
            if (changed) { inp.chCt = data.ct; inp.chTick = inp.ackTick }
        }
        if (data.held && typeof data.held === "object") {
            for (const a of NET_ACTIONS) inp.held[a] = !!data.held[a]
        }
        if (Array.isArray(data.taps)) {
            for (const t of data.taps) {
                const a = typeof t === "string" ? t : (t && t.action)
                if (NET_ACTIONS.has(a)) { inp.taps.add(a); inp.tapAge.set(a, 0) }
            }
        }
        break
    }

    default: break
    }
}

function handleDisconnect(socket) {
    const code = socket._roomCode
    if (!code) { broadcastLobby(); return }

    const room = rooms.get(code)
    if (!room) return

    if (socket._spectator) {
        room.spectators = room.spectators.filter(s => s !== socket)
    } else {
        // A player disconnected — end the session
        closeRoom(code)
    }
    broadcastLobby()
}

// Keepalive: hosting proxies drop idle sockets, and a silently dead peer would otherwise keep a room alive.
const pingTimer = setInterval(() => {
    wss.clients.forEach(c => {
        if (c._alive === false) { c.terminate(); return }
        c._alive = false
        try { c.ping() } catch (e) {}
    })
}, PING_INTERVAL_MS)
if (pingTimer.unref) pingTimer.unref()

// Lets a test harness drive the simulation without opening sockets
if (require.main !== module) {
    module.exports = { makeGame, tick, blankInput, buildStatePacket, buildStateObject, endTickTaps, startTickLoop, platforms, wss }
}

console.log(`Server running on port ${PORT}`)
