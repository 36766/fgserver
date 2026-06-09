const WebSocket = require("ws")
const PORT = process.env.PORT || 10000
const wss = new WebSocket.Server({ port: PORT })

// ─── Physics constants (must match client) ───────────────────────────────────
const GRAVITY          = 0.8
const FRICTION         = 0.85
const AIR_ACCEL        = 0.6
const GROUND_ACCEL     = 1.0
const JUMP_POWER       = 18
const SHORT_HOP_POWER  = 12
const MAX_FALL         = 12
const WALL_SLIDE_SPEED = 1.5
const FAST_FALL_SPEED  = 18
const WALL_JUMP_BUFFER = 6
const AIR_DRAG         = 0.96
const GROUND_DRAG      = 0.78
const HIT_FALL_MULT    = 0.9
const DASH_SPEED       = 16
const DASH_THRESHOLD   = 3
const PARRY_DASH_SPEED = 14
const PARRY_WINDOW     = 15
const PARRY_COST       = 50
const PARRY_REFUND     = 20
const BURST_COST       = 100
const BURST_PARRY_COST = 50
const BURST_PARRY_WIN  = 15
const SHIELD_MAX       = 150
const SHIELD_REGEN     = 0.05
const NEUTRAL_DRAG_HITSTUN = 14
const WITCH_DURATION   = 300
const WITCH_SLOW       = 0.8
const WITCH_BOOST      = 1.1
const WITCH_ATK_BOOST  = 1.5
const WITCH_HITSTUN_MULT = 2.5

// ─── Stage ───────────────────────────────────────────────────────────────────
const CANVAS_W = 1500
const CANVAS_H = 855
const CX = CANVAS_W / 2

const platforms = [
    { x: CX - 500, y: 500, w: 1000, h: 1000, topOnly: false },
    { x: CX - 400, y: 350, w: 180,  h: 20,   topOnly: true  },
    { x: CX + 220, y: 350, w: 180,  h: 20,   topOnly: true  }
]

const blast = { left: -500, right: CANVAS_W + 500, top: -600, bottom: CANVAS_H + 600 }

const spawnPoints = [
    { x: 380, y: 200 },
    { x: 950, y: 200 }
]

// ─── Character move tables ────────────────────────────────────────────────────
// Each entry: { offsetX, offsetY, w, h, damage, angle, kb, multihit, moveTag, delayFrames }
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
                down:    { lockFrames:12,cooldown:25,hitboxes:[{ offsetX:10,offsetY:40, w:70, h:20,damage:2,angle:70, kb:6,delayFrames:0,moveTag:"speedster-down-ground"  }] }
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
        freeParryDashCharges: 0,
        burstParryWindow: 0,
        burstHoverFrames: 0,
        freezeFrames: 0,
        attackCooldown: 0,
        attackLockFrames: 0,
        dashCooldown: 0,
        dashDir: 0,
        dashLockFrames: 0,
        airDashBufferFrames: 0,
        airDashBufferDir: 0,
        jumpSquatFrames: 0,
        jumpQueued: false,
        jumpSquatStartedThisFrame: false,
        jumpSquatHoldFrames: 0,
        doubleJump: true,
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
        hitFallMultiplier: HIT_FALL_MULT
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
let game = null   // null = waiting for both players

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
        gameOver: false,
        winnerIdx: -1,
        pendingEvents: []   // { type, data, applyAtFrame } — replaces setTimeout
    }
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

// ─── Physics ──────────────────────────────────────────────────────────────────
function checkStageCollision(f) {
    for (const p of platforms) {
        const isTop = p.topOnly
        if (f.x + f.w > p.x && f.x < p.x + p.w) {
            if (f.y + f.h > p.y && f.y + f.h - f.vy <= p.y + 1) {
                if (isTop && f.platformDrop) continue
                if (f.vy >= 0) {
                    if (f.hitstun > 0 && f.vy >= 4) {
                        f.vy = -Math.abs(f.vy) * 0.92
                        f.percent += 0.5
                    } else {
                        f.vy = 0
                    }
                    f.y = p.y - f.h
                    f.onGround = true
                    f.wallJumpsLeft = f.maxWallJumps
                    f.wallJumpCount = 0
                }
            }
        }
        if (!isTop) {
            if (f.y + f.h > p.y && f.y < p.y + p.h) {
                if (f.x + f.w > p.x && f.x + f.w < p.x + 15) {
                    f.touchingWall = 1
                    f.x = p.x - f.w
                    if (f.hitstun > 0) { f.vx = -f.vx; f.percent += 0.5 }
                    else f.vx = 0
                }
                if (f.x < p.x + p.w && f.x > p.x + p.w - 15) {
                    f.touchingWall = -1
                    f.x = p.x + p.w
                    if (f.hitstun > 0) { f.vx = -f.vx; f.percent += 0.5 }
                    else f.vx = 0
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
        checkStageCollision(f)
        if (f.onGround && dy > 0) break
    }
}

function applyPhysics(f, inp, witchTime) {
    const slow = f.witchTimeVictim ? WITCH_SLOW : f.witchTimeOwner ? WITCH_BOOST : 1

    if (f.burstHoverFrames > 0) {
        f.vy = -0.2
        f.vx *= 0.2
        f.burstHoverFrames--
        return
    }

    if (f.parryDashFrames > 0) {
        f.vx = f.parryDashVX
        f.vy = f.parryDashVY
        const wasOnGround = f.onGround
        f.onGround = false
        f.touchingWall = 0
        safeMove(f, f.vx, f.vy)
        if (!f.onGround && wasOnGround && Math.abs(f.parryDashVY) < 0.001) {
            for (const p of platforms) {
                if (f.x + f.w > p.x && f.x < p.x + p.w && Math.abs((f.y + f.h) - p.y) <= 10) {
                    f.y = p.y - f.h; f.onGround = true; f.vy = 0; break
                }
            }
        }
        if (f.onGround) { f.doubleJump = true; f.wallJumpsLeft = f.maxWallJumps }
        return
    }

    f.vy += GRAVITY * slow

    if (f.hitfallQueued && !f.onGround && f.touchingWall === 0 && f.hitstun <= 0) {
        f.vy = FAST_FALL_SPEED * slow
        f.hitfallQueued = false
    }

    if (!f.onGround) {
        if (inp.held.down && f.hitstun <= 0) {
            f.vy = f.vy > 0 ? Math.min(f.vy + slow, FAST_FALL_SPEED * slow) : f.vy + 0.3 * slow
        } else if (inp.held.jump && f.hitstun <= 0) {
            const cutoff = MAX_FALL * 0.35
            if (f.vy > 0 && f.vy < cutoff) f.vy *= 0.85
            else if (f.vy <= 0) f.vy -= 0.2 * slow
        }
    }

    if (f.hitstun > 0) {
        const drag = f.onGround ? GROUND_DRAG : AIR_DRAG
        f.vx *= drag; f.vy *= drag
        if (f.vy > MAX_FALL) f.vy = Math.max(f.vy - 0.3, MAX_FALL)
        if (Math.abs(f.vx) < 0.08) f.vx = 0
        if (Math.abs(f.vy) < 0.08) f.vy = 0
    } else {
        if (f.vy > MAX_FALL && !inp.held.down) f.vy = MAX_FALL
        if (f.onGround) f.vx *= FRICTION
        else { f.vx *= 0.93; f.vx = Math.max(-20, Math.min(20, f.vx)) }
    }

    let mvx = f.vx * slow
    let mvy = f.vy * slow
    const maxD = Math.min(f.w, f.h) * 2
    const mag  = Math.sqrt(mvx * mvx + mvy * mvy)
    if (mag > maxD) { mvx *= maxD / mag; mvy *= maxD / mag }

    const wasOnGround = f.onGround
    f.onGround = false
    f.touchingWall = 0
    safeMove(f, mvx, mvy)

    if (f.onGround) {
        f.doubleJump = true
        f.wallJumpsLeft = f.maxWallJumps
        if (!wasOnGround && f.attackCooldown > 0) f.attackCooldown -= 10
    }
    if (f.touchingWall !== 0 && !f.onGround) {
        f.vy = Math.min(f.vy, WALL_SLIDE_SPEED * slow)
    }
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

// ─── Controls ─────────────────────────────────────────────────────────────────
function processControls(f, opp, inp, taps, g) {
    if (f.hitstun > 0) {
        if (taps.has("parry")) activateBurst(f, opp, g)
        return
    }

    advanceJumpSquat(f, inp)

    const leftTap  = taps.has("left")
    const rightTap = taps.has("right")
    const jumpTap  = taps.has("jump")

    // Parry / witch-time / burst
    if (taps.has("parry")) {
        if (f.shield >= f.shieldMax && opp.hitstun > 0) {
            triggerWitchTime(f, opp, g)
        } else {
            const dv = getDashVec(inp)
            startParry(f, opp, dv)
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

    if (f.parryDashFrames > 0) {
        if (jumpTap) abortParryDash(f, true)
        return
    }

    // Air dash buffer
    if (!f.onGround) {
        if (leftTap && !rightTap)  { f.airDashBufferFrames = 8; f.airDashBufferDir = -1 }
        else if (rightTap && !leftTap) { f.airDashBufferFrames = 8; f.airDashBufferDir = 1 }
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

    // Ground dash buffer flush
    if (f.onGround && f.airDashBufferFrames > 0) {
        const dir = f.airDashBufferDir
        if (Math.abs(f.vx) < DASH_THRESHOLD + 1) {
            f.vx = dir * DASH_SPEED; f.dashDir = dir
            f.dashLockFrames = 10; f.iFrames = 10; f.parryFrames = 10
            if (dir !== 0) f.facing = dir
        }
        f.airDashBufferFrames = 0; f.airDashBufferDir = 0; moveDir = 0
    }

    if (moveDir === -1) {
        if (f.onGround && leftTap && Math.abs(f.vx) < DASH_THRESHOLD) {
            f.vx = -DASH_SPEED; f.dashDir = -1; f.dashLockFrames = 12; f.iFrames = 8; f.parryFrames = 8
        } else { f.vx -= (f.onGround ? GROUND_ACCEL : AIR_ACCEL) * slow }
        f.facing = -1
    } else if (moveDir === 1) {
        if (f.onGround && rightTap && Math.abs(f.vx) < DASH_THRESHOLD) {
            f.vx = DASH_SPEED; f.dashDir = 1; f.dashLockFrames = 12; f.iFrames = 8; f.parryFrames = 8
        } else { f.vx += (f.onGround ? GROUND_ACCEL : AIR_ACCEL) * slow }
        f.facing = 1
    }

    f.platformDrop = inp.held.down

    if (jumpTap && !attackLocked) {
        if (f.onGround) { f.jumpSquatFrames = 2; f.jumpQueued = true; f.jumpSquatStartedThisFrame = true; f.jumpSquatHoldFrames = 0 }
        else if (f.touchingWall !== 0) doJump(f, false)
        else if (f.doubleJump)         doJump(f, false)
    }

    // Attack
    if (taps.has("attack") && f.attackCooldown <= 0) {
        let dir = "neutral"
        if (inp.held.jump)                       dir = "up"
        else if (inp.held.down)                  dir = "down"
        else if (inp.held.left || inp.held.right) dir = "forward"
        if (f.jumpSquatFrames > 0) { f.jumpSquatFrames = 0; f.jumpQueued = false }
        doAttack(f, dir)
    }

    // Special
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
function doAttack(f, direction) {
    if (f.attackCooldown > 0) return
    const m = getMoveset(f.characterName, direction, f.onGround)
    if (!m) return
    f.attackLockFrames = m.lockFrames
    f.attackCooldown   = m.cooldown
    for (const hd of m.hitboxes) {
        f.delayedHitboxes.push({ ...hd, frames: hd.delayFrames || 0 })
    }
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
    f.x = ox + ux * OVERSHOOT - f.w / 2
    f.y = oy + uy * OVERSHOOT - f.h / 2
    f.vx = 0; f.vy = 0; f.doubleJump = true

    const dashKB = 16
    const launchUY = uy - 0.1
    opp.vx = ux * dashKB; opp.vy = launchUY * dashKB
    opp.launchVelX = opp.vx; opp.launchVelY = opp.vy; opp.launchKB = dashKB
    opp.hitstun = 28; opp.percent += 4; opp.damageFlash = 6
    g.hitstopFrames = 22
    registerComboHit(f, opp)
    recordMove(f, "speedster-dashthrough")
    f.hitConfirmWindow = 8

    // Frame-counted shockwave events replace setTimeout
    const rawDist = dist
    const SHORT_THRESHOLD = 40
    const SHOCK_SPACING   = 140
    if (rawDist > SHORT_THRESHOLD) {
        const shockCount = Math.max(1, Math.floor((rawDist - SHORT_THRESHOLD) / SHOCK_SPACING))
        const totalDX = (ox + ux * OVERSHOOT) - sx
        const totalDY = (oy + uy * OVERSHOOT) - sy
        for (let i = 0; i < shockCount; i++) {
            const t = (i + 1) / (shockCount + 1)
            g.pendingEvents.push({
                type: "shockwave",
                applyAtFrame: g.frame + Math.round((shockCount - i) * 3.6),
                data: { x: sx + totalDX * t, y: sy + totalDY * t, angle: Math.atan2(uy, ux), scale: 0.4 + t * 0.9 }
            })
        }
    }
}

function doMageSpecial(f, opp, g) {
    if (f.dashCooldown > 0) return
    f.dashCooldown = 150
    g.pendingEvents.push({ type: "spawnRoot", applyAtFrame: g.frame, data: { targetIdx: f === g.fighters[0] ? 1 : 0 } })
}

function doNinjaSpecial(f, opp, g) {
    if (f.dashCooldown > 0 || opp.hitstun <= 0) return
    f.dashCooldown = 150
    g.pendingEvents.push({ type: "spawnClone", applyAtFrame: g.frame, data: { ownerIdx: f === g.fighters[0] ? 0 : 1 } })
}

// ─── Combo helpers ────────────────────────────────────────────────────────────
function registerComboHit(attacker, defender) {
    if (attacker.comboVictim === defender && defender.hitstun > 0) {
        attacker.comboCount++
        if (attacker.witchTimeOwner) {
            attacker.freeParryDashCharges++
        }
    } else {
        attacker.comboCount = 1
        attacker.comboVictim = defender
    }
}

// ─── Parry / burst / witch-time ───────────────────────────────────────────────
function startParry(f, opp, dashVec) {
    const isFree = dashVec && f.freeParryDashCharges > 0
    if (!isFree && f.shield < PARRY_COST) return
    if (isFree) f.freeParryDashCharges--
    else f.shield -= PARRY_COST
    f.parryFrames = PARRY_WINDOW
    if (dashVec) {
        f.parryDashFrames = PARRY_WINDOW
        f.parryDashStoredVX = f.vx; f.parryDashStoredVY = f.vy
        f.parryDashVX = dashVec.x * PARRY_DASH_SPEED
        f.parryDashVY = dashVec.y * PARRY_DASH_SPEED
        f.vx = f.parryDashVX; f.vy = f.parryDashVY
        f.iFrames = Math.max(f.iFrames, PARRY_WINDOW)
        if (opp && opp.hitstun > 0) opp.hitstun += 15
        if (Math.abs(f.parryDashVX) > 0.01) f.facing = f.parryDashVX < 0 ? -1 : 1
    }
}

function finishParryDash(f) {
    if (f.parryDashStoredVX === null) return
    f.vx = f.parryDashVX * 0.8; f.vy = f.parryDashVY * 0.8
    f.parryDashFrames = 0; f.parryDashVX = 0; f.parryDashVY = 0
    f.parryDashStoredVX = null; f.parryDashStoredVY = null; f.parryFrames = 0
}

function abortParryDash(f, keepMomentum) {
    if (f.parryDashStoredVX === null) return
    if (keepMomentum) { f.vx = f.parryDashVX * 1.4; f.vy = f.parryDashVY }
    f.parryDashFrames = 0; f.parryFrames = 0; f.iFrames = 0
    f.parryDashVX = 0; f.parryDashVY = 0; f.parryDashStoredVX = null; f.parryDashStoredVY = null
}

function activateBurst(f, opp, g) {
    if (f.burstParryWindow > 0 && f.shield >= BURST_PARRY_COST) {
        f.shield -= BURST_PARRY_COST; f.burstParryWindow = 0
        f.hitstun = 0; f.vx = 0; f.vy = 0; f.burstHoverFrames = 0
        return
    }
    if (f.shield < BURST_COST || f.hitstun <= 0) return
    f.shield -= BURST_COST; f.vx = 0; f.vy = 0; f.hitstun = 0
    f.burstHoverFrames = 15; f.doubleJump = true
    // Burst wave spawns after 19 frames (≈320ms at 60fps)
    g.pendingEvents.push({
        type: "burstWave",
        applyAtFrame: g.frame + 19,
        data: {
            ownerIdx: f === g.fighters[0] ? 0 : 1,
            x: f.x + f.w / 2,
            y: f.y + f.h / 2
        }
    })
}

function triggerWitchTime(f, opp, g) {
    if (f.shield < f.shieldMax) return
    f.shield = 0; f.doubleJump = true
    g.witchTime = { frames: WITCH_DURATION, ownerIdx: g.fighters.indexOf(f), targetIdx: g.fighters.indexOf(opp) }
    f.witchTimeOwner = true; opp.witchTimeVictim = true
    opp.hitboxes = []; opp.delayedHitboxes = []
}

function triggerJudgementCut(f, opp, g) {
    const dx = (opp.x + opp.w/2) - (f.x + f.w/2)
    const dy = (opp.y + opp.h/2) - (f.y + f.h/2)
    if (Math.abs(dx) >= 150 || Math.abs(dy) >= 100) return
    if (!((f.facing === 1 && dx > 0) || (f.facing === -1 && dx < 0))) return
    f.shield = 0; f.ultimateActive = true
    f.freezeFrames = 95; f.vx = 0; f.vy = 0
    opp.freezeFrames = 95; opp.vx = 0; opp.vy = 0; opp.hitstun = 95
    g.hitstopFrames = 90
    // Damage after 60 frames (≈1000ms at 60fps)
    g.pendingEvents.push({
        type: "judgementCutDamage",
        applyAtFrame: g.frame + 60,
        data: { targetIdx: g.fighters.indexOf(opp) }
    })
}

function triggerShadowAssaultInitial(f, opp, g) {
    const dx = (opp.x + opp.w/2) - (f.x + f.w/2)
    const dy = (opp.y + opp.h/2) - (f.y + f.h/2)
    if (Math.abs(dx) >= 200 || Math.abs(dy) >= 150) return
    if (!((f.facing === 1 && dx > 0) || (f.facing === -1 && dx < 0))) return
    f.shield = 0; f.ultimateActive = true
    f.x = opp.x + (f.facing > 0 ? opp.w + 20 : -f.w - 20); f.y = opp.y
    f.facing = -f.facing; f.vx = 0; f.vy = 0
    opp.vx = 0; opp.vy = -18; opp.hitstun = 200; opp.freezeFrames = 0
    g.hitstopFrames = 10
    // Final slam after 70 frames
    g.pendingEvents.push({
        type: "shadowAssaultSlam",
        applyAtFrame: g.frame + 70,
        data: {
            attackerIdx: g.fighters.indexOf(f),
            targetIdx:   g.fighters.indexOf(opp)
        }
    })
}

// ─── Hit detection ────────────────────────────────────────────────────────────
function runHitDetection(attacker, defender, g) {
    for (const h of attacker.hitboxes) {
        if (!h.active()) continue
        const overlaps =
            h.x < defender.x + defender.w && h.x + h.w > defender.x &&
            h.y < defender.y + defender.h && h.y + h.h > defender.y
        if (!overlaps) continue

        // Parry
        if (defender.parryFrames > 0) {
            attacker.freezeFrames = 20; attacker.vx = 0; attacker.vy = 0
            attacker.hitboxes = []
            if (defender.parryDashFrames > 0) { defender.vx = defender.parryDashVX; defender.vy = defender.parryDashVY }
            else { defender.vx = 0; defender.vy = 0; defender.parryFrames = 0 }
            defender.shield = Math.min(defender.shieldMax, defender.shield + PARRY_REFUND)
            g.pendingEvents.push({ type: "parryFx", applyAtFrame: g.frame, data: { x: defender.x + defender.w/2, y: defender.y + defender.h/2 } })
            return
        }

        if (defender.iFrames > 0) continue
        if (h.hitTargets.has(defender)) continue

        const moveTag   = h.moveTag || "generic"
        const isDrag    = moveTag === "speedster-neutral-dragdown"
        const stale     = getStaleFactor(attacker, moveTag)

        if (isDrag) {
            const mag = Math.hypot(attacker.vx, attacker.vy)
            defender.vx = attacker.vx * 0.6
            defender.vy = (Math.tanh(attacker.vy / 15) * 15 - 2.5) * 0.8
            defender.percent  += h.damage
            defender.hitstun   = NEUTRAL_DRAG_HITSTUN
            defender.launchKB  = mag
            defender.damageFlash = 2
            defender.hitboxes = []; defender.delayedHitboxes = []
            attacker.hitConfirmWindow = 6
            registerComboHit(attacker, defender)
            recordMove(attacker, moveTag)
            h.hitTargets.add(defender)
            if (!h.multihit) h.frames = 0
            g.hitstopFrames = Math.max(g.hitstopFrames, 4)
            g.pendingEvents.push({ type: "hitFx", applyAtFrame: g.frame, data: { x: defender.x + defender.w/2, y: defender.y + defender.h/2, kb: mag, isDrag: true } })
            continue
        }

        const rawKb = h.kb + Math.pow(defender.percent, 1.5) * 0.023 + 14
        let   kb    = rawKb * ((stale + 2) / 3)
        const launchAngle = h.angle * Math.PI / 180
        const cr    = counterVelocityBonus(defender, h.angle, attacker.facing)
        const effDmg = h.damage * cr.multiplier
        kb *= 1 + (cr.multiplier - 1) * 0.2

        const dmgHitstop = Math.min(10, effDmg)

        if (defender.percent >= 100) {
            kb *= 1.6
            g.hitstopFrames = Math.max(g.hitstopFrames, 35 + dmgHitstop)
        } else {
            const upness = Math.max(0, Math.sin(launchAngle))
            const hsm    = 1 - upness * 0.3
            const total  = Math.max(g.hitstopFrames, 3 + kb * hsm * 0.6 + dmgHitstop)
            g.hitstopFrames        = Math.max(g.hitstopFrames, Math.ceil(total * 0.7))
            g.attackerFreezeFrames = Math.max(g.attackerFreezeFrames, Math.floor(total * 0.3))
            g.attackerFreezeIdx    = g.fighters.indexOf(attacker)
        }

        const launchX = Math.cos(launchAngle) * kb * attacker.facing
        const launchY = -Math.sin(launchAngle) * kb
        const vf      = Math.abs(Math.sin(launchAngle))
        const vhm     = 1 - vf * 0.6
        const staleH  = Math.max(0, stale + 0.05)
        let   baseHitstun = Math.floor((rawKb + 5) * 2.5 * vhm * (staleH + 0.5) / 1.5)
        if (attacker.witchTimeOwner) baseHitstun *= WITCH_HITSTUN_MULT

        defender.pendingLaunch = { baseVx: launchX, baseVy: launchY, baseSpeed: kb, hitstun: Math.max(0, baseHitstun) }
        defender.vx = launchX; defender.vy = launchY
        defender.launchVelX = launchX; defender.launchVelY = launchY; defender.launchKB = kb
        defender.hitstun  = Math.max(0, baseHitstun)
        defender.percent += effDmg
        defender.damageFlash = 2
        defender.hitboxes = []; defender.delayedHitboxes = []
        attacker.hitConfirmWindow = 6
        registerComboHit(attacker, defender)
        recordMove(attacker, moveTag)

        h.hitTargets.add(defender)
        if (!h.multihit) h.frames = 0

        g.pendingEvents.push({
            type: "hitFx",
            applyAtFrame: g.frame,
            data: {
                x: defender.x + defender.w/2, y: defender.y + defender.h/2,
                kb, angle: h.angle, attackerFacing: attacker.facing,
                isCounter: cr.isCounter, isKill: defender.percent > 200
            }
        })
    }
}

// ─── DI resolution ────────────────────────────────────────────────────────────
function resolveDI(f, inp) {
    if (!f.pendingLaunch) return
    const p  = f.pendingLaunch
    const ix = (inp.held.right ? 1 : 0) - (inp.held.left ? 1 : 0)
    const iy = (inp.held.down  ? 1 : 0) - (inp.held.jump ? 1 : 0)
    let fx = p.baseVx, fy = p.baseVy
    if (ix !== 0 || iy !== 0) {
        const mag = Math.hypot(ix, iy) || 1
        const ux  = ix / mag, uy = iy / mag
        const lm  = Math.hypot(p.baseVx, p.baseVy) || 1
        const lux = p.baseVx / lm, luy = p.baseVy / lm
        const dot = lux * ux + luy * uy
        const cross = lux * uy - luy * ux
        const shift = Math.sign(cross || 1) * Math.pow(Math.abs(cross), 1.8) * (10 * Math.PI / 180)
        const cosA  = Math.cos(shift), sinA = Math.sin(shift)
        const rx    = lux * cosA - luy * sinA, ry = lux * sinA + luy * cosA
        const km    = p.baseSpeed * Math.max(0.6, Math.min(1.25, 1 + dot * 0.15))
        fx = rx * km; fy = ry * km
    }
    f.vx = fx; f.vy = fy
    f.launchVelX = fx; f.launchVelY = fy
    f.launchKB   = Math.hypot(fx, fy)
    f.hitstun    = p.hitstun
    f.pendingLaunch = null
}

// ─── Blast zone / respawn ─────────────────────────────────────────────────────
function checkBlast(f, idx, g) {
    if (f.x >= blast.left && f.x <= blast.right && f.y >= blast.top && f.y <= blast.bottom) return
    f.percent = 0; f.trailingPercent = 0; f.stocks--
    f.comboCount = 0; f.comboVictim = null
    g.pendingEvents.push({ type: "blastFx", applyAtFrame: g.frame, data: { x: Math.max(-300, Math.min(CANVAS_W + 300, f.x + f.w/2)), y: Math.max(-300, Math.min(CANVAS_H + 300, f.y + f.h/2)) } })

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
    f.parryDashFrames = 0; f.parryDashVX = 0; f.parryDashVY = 0
    f.parryDashStoredVX = null; f.parryDashStoredVY = null; f.freeParryDashCharges = 0
}

// ─── Main tick ────────────────────────────────────────────────────────────────
function tick(g, inputs) {
    if (g.gameOver) return
    g.frame++

    const [f0, f1] = g.fighters
    const inp      = [inputs[0], inputs[1]]
    const taps     = [inputs[0].taps, inputs[1].taps]

    // Witch time bookkeeping
    if (g.witchTime.frames > 0) {
        g.witchTime.frames--
        if (g.witchTime.frames <= 0) {
            f0.witchTimeOwner = false; f0.witchTimeVictim = false
            f1.witchTimeOwner = false; f1.witchTimeVictim = false
            g.witchTime = { frames: 0, ownerIdx: -1, targetIdx: -1 }
        }
    }

    // Fire pending events whose frame has arrived
    g.pendingEvents = g.pendingEvents.filter(ev => {
        if (ev.applyAtFrame > g.frame) return true
        applyPendingEvent(ev, g)
        return false
    })

    // Shield regen
    for (const f of g.fighters) {
        if (f.parryFrames <= 0 && f.shield < f.shieldMax) {
            const s1 = f.shieldMax / 3, s2 = f.shieldMax * 2 / 3
            const rm = f.shield <= s1 ? 2 : f.shield <= s2 ? 1.2 : 0.2
            f.shield = Math.min(f.shieldMax, f.shield + SHIELD_REGEN * rm)
        }
        if (f.parryFrames > 0) f.parryFrames--
        if (f.parryDashFrames > 0) { f.parryDashFrames--; if (f.parryDashFrames <= 0) finishParryDash(f) }
        if (f.burstParryWindow > 0) f.burstParryWindow--
        if (f.hitstun > 0) { f.hitstun--; f.vy += GRAVITY * (HIT_FALL_MULT - 1) }
        if (f.attackCooldown > 0) f.attackCooldown -= (f.witchTimeOwner ? WITCH_ATK_BOOST : 1)
        if (f.attackLockFrames > 0) f.attackLockFrames--
        if (f.dashCooldown > 0)     f.dashCooldown--
        if (f.airDashBufferFrames > 0) f.airDashBufferFrames--
        if (f.iFrames > 0)          f.iFrames--
        if (f.hitConfirmWindow > 0) {
            f.hitConfirmWindow--
            if (inp[g.fighters.indexOf(f)].taps.has("down") && !f.onGround && f.hitstun <= 0) {
                f.hitfallQueued = true
            }
        }

        // Delayed hitboxes
        for (let i = f.delayedHitboxes.length - 1; i >= 0; i--) {
            const dh = f.delayedHitboxes[i]
            dh.frames--
            if (dh.frames <= 0) {
                f.hitboxes.push(new SHitbox(f, dh.offsetX, dh.offsetY, dh.w, dh.h, dh.damage, dh.angle, dh.kb, dh.multihit, dh.moveTag))
                f.delayedHitboxes.splice(i, 1)
            }
        }

        // Update hitboxes
        for (const h of f.hitboxes) h.update()
        f.hitboxes = f.hitboxes.filter(h => h.active())

        // Trailing percent
        if (f.hitstun <= 0 && f.trailingPercent < f.percent) {
            f.trailingPercent = Math.min(f.percent, f.trailingPercent + 2.2)
        }
    }

    if (g.hitstopFrames > 0 || g.attackerFreezeFrames > 0) {
        if (g.hitstopFrames > 0) {
            g.hitstopFrames--
            if (g.hitstopFrames <= 0) {
                resolveDI(f0, inp[0])
                resolveDI(f1, inp[1])
            }
        } else {
            g.attackerFreezeFrames--
            const atk = g.fighters[g.attackerFreezeIdx]
            const def = g.fighters[1 - g.attackerFreezeIdx]
            const ai  = g.attackerFreezeIdx
            processControls(atk, def, inp[ai], taps[ai], g)
            applyPhysics(atk, inp[ai], g.witchTime)
            checkBlast(atk, ai, g)
            runHitDetection(atk, def, g)
            if (g.attackerFreezeFrames <= 0) {
                g.attackerFreezeIdx = -1
                resolveDI(f0, inp[0])
                resolveDI(f1, inp[1])
            }
        }
        return
    }

    // Normal tick — both fighters
    for (let i = 0; i < 2; i++) {
        const f   = g.fighters[i]
        const opp = g.fighters[1 - i]
        if (f.freezeFrames > 0) { f.freezeFrames--; continue }
        processControls(f, opp, inp[i], taps[i], g)
        applyPhysics(f, inp[i], g.witchTime)
        checkBlast(f, i, g)
    }

    runHitDetection(f0, f1, g)
    runHitDetection(f1, f0, g)
}

function applyPendingEvent(ev, g) {
    // These are purely informational signals to clients — the server doesn't need
    // to do any additional state mutation here for most events (hitFx, shockwave etc.)
    // The exceptions are game-logic events that must mutate fighter state.
    if (ev.type === "judgementCutDamage") {
        const target = g.fighters[ev.data.targetIdx]
        target.percent += 30
        const a = Math.random() * Math.PI * 2
        target.vx = Math.cos(a) * 15; target.vy = -Math.sin(a) * 15
        target.hitstun = 40
        const attacker = g.fighters[1 - ev.data.targetIdx]
        attacker.ultimateActive = false
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
    // burstWave: apply stun to opponent if in range
    if (ev.type === "burstWave") {
        const opp = g.fighters[1 - ev.data.ownerIdx]
        const dx  = (opp.x + opp.w/2) - ev.data.x
        const dy  = (opp.y + opp.h/2) - ev.data.y
        if (Math.hypot(dx, dy) < 300 && opp.iFrames <= 0) {
            opp.vx = 0; opp.vy = 0; opp.hitstun = 20
            opp.freezeFrames = 35; opp.doubleJump = true
            opp.burstParryWindow = BURST_PARRY_WIN
            g.hitstopFrames = Math.max(g.hitstopFrames, 12)
        }
    }
}

// ─── Serialise state for clients ─────────────────────────────────────────────
function buildStatePacket(g) {
    const fighters = g.fighters.map(f => ({
        x: f.x, y: f.y, vx: f.vx, vy: f.vy,
        facing: f.facing, onGround: f.onGround,
        hitstun: f.hitstun, percent: f.percent,
        stocks: f.stocks, shield: f.shield,
        dashCooldown: f.dashCooldown,
        burstHoverFrames: f.burstHoverFrames,
        freezeFrames: f.freezeFrames,
        damageFlash: f.damageFlash,
        hitConfirmWindow: f.hitConfirmWindow,
        witchTimeOwner: f.witchTimeOwner,
        witchTimeVictim: f.witchTimeVictim,
        parryFrames: f.parryFrames,
        ultimateActive: f.ultimateActive,
        launchKB: f.launchKB,
        trailingPercent: f.trailingPercent,
        attackLockFrames: f.attackLockFrames
    }))

    // Flush pending events as client VFX signals
    const vfxEvents = g.pendingEvents.filter(e => e.applyAtFrame <= g.frame)

    return JSON.stringify({
        type: "state",
        frame: g.frame,
        fighters,
        witchTime: g.witchTime,
        hitstopFrames: g.hitstopFrames,
        gameOver: g.gameOver,
        winnerIdx: g.winnerIdx,
        vfxEvents: g.pendingEvents.filter(e => e.applyAtFrame === g.frame).map(e => ({ type: e.type, data: e.data }))
    })
}

// ─── Session management ───────────────────────────────────────────────────────
let sessions = []   // { sockets: [s0, s1], inputs: [{held, taps}, ...], characters: [], ready: 0 }
let waiting   = null

function blankInput() {
    return { held: { left:false, right:false, jump:false, down:false, attack:false, dash:false, parry:false, ultimate:false }, taps: new Set() }
}

wss.on("connection", socket => {
    console.log("Player connected")

    if (!waiting) {
        waiting = { socket, character: "speedster" }
        socket.send(JSON.stringify({ type: "playerNumber", number: 0 }))
        socket.on("message", msg => handleLobbyMessage(socket, msg, 0))
        socket.on("close", () => { if (waiting && waiting.socket === socket) waiting = null })
    } else {
        const p0 = waiting; waiting = null
        socket.send(JSON.stringify({ type: "playerNumber", number: 1 }))

        const session = {
            sockets:    [p0.socket, socket],
            inputs:     [blankInput(), blankInput()],
            characters: [p0.character, "speedster"],
            interval:   null
        }
        sessions.push(session)
        startSession(session)

        socket.on("message", msg => handleSessionMessage(session, socket, msg, 1))
        p0.socket.removeAllListeners("message")
        p0.socket.on("message", msg => handleSessionMessage(session, p0.socket, msg, 0))

        socket.on("close",    () => endSession(session))
        p0.socket.on("close", () => endSession(session))
    }
})

function handleLobbyMessage(socket, msg, idx) {
    try {
        const data = JSON.parse(msg)
        if (data.type === "character" && waiting && waiting.socket === socket) {
            waiting.character = data.character || "speedster"
        }
    } catch(e) {}
}

function handleSessionMessage(session, socket, msg, idx) {
    try {
        const data = JSON.parse(msg)
        if (data.type === "input") {
            const inp = session.inputs[idx]
            if (data.held) inp.held = data.held
            if (Array.isArray(data.taps)) {
                for (const t of data.taps) inp.taps.add(t)
            }
        }
    } catch(e) {}
}

function startSession(session) {
    session.game = makeGame(session.characters)
    session.interval = setInterval(() => {
        const g = session.game
        tick(g, session.inputs)
        // Clear taps after each tick so they are consumed exactly once
        session.inputs[0].taps.clear()
        session.inputs[1].taps.clear()

        const pkt = buildStatePacket(g)
        for (const s of session.sockets) {
            if (s.readyState === WebSocket.OPEN) s.send(pkt)
        }

        if (g.gameOver) {
            clearInterval(session.interval)
            session.interval = null
        }
    }, 1000 / 60)
}

function endSession(session) {
    console.log("Session ended")
    if (session.interval) clearInterval(session.interval)
    sessions = sessions.filter(s => s !== session)
    for (const s of session.sockets) {
        if (s.readyState === WebSocket.OPEN) s.close()
    }
}

console.log(`Server running on port ${PORT}`)