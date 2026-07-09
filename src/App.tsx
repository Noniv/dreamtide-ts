import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Engine, type HudState, type Choice } from './game/engine';
import { SPELLS, BOONS, GENERIC, EVOLVE } from './game/spells';
import { SpellIcon, SpellIconInner, HAS_ICON } from './game/spellIcons';
import { audio } from './game/audio';
import { settings, RESOLUTION_OPTIONS, type Preset, type PerfPresets, type ResolutionScale } from './game/settings';
import { isNative, exitApp } from './game/nativeWindow';
import {
  TREE_NODES, TREE_EDGES, NODE_MAP, CLUSTER_INFO, loadMeta, saveMeta,
  canBuy, buyNode, canRefund, refundNode, refundValue, isReachable,
  computeBonuses, dustForRun, setLoadout, loadoutSlots, unlockedSpells,
  type Meta, type TreeNode,
} from './game/meta';

type Screen = 'menu' | 'playing' | 'levelup' | 'dead' | 'tree' | 'settings';

interface RunResult { time: number; kills: number; level: number; bonusDust: number; shards: number }

interface GameStore {
  screen: Screen;
  hud: HudState | null;
  choices: Choice[];
  newLevel: number;
  banishes: number;
  rerolls: number;
  result: RunResult | null;
  dustEarned: number;
  meta: Meta;
  muted: boolean;
  set: (partial: Partial<GameStore>) => void;
}

const useGame = create<GameStore>((set) => ({
  screen: 'menu',
  hud: null,
  choices: [],
  newLevel: 1,
  banishes: 0,
  rerolls: 0,
  result: null,
  dustEarned: 0,
  meta: loadMeta(),
  muted: false,
  set,
}));

function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const { screen, hud, choices, newLevel, banishes, rerolls, result, dustEarned, meta, set } = useGame();
  // menu → run cross-fade: the run starts immediately, but the menu stays
  // mounted with a `closing` class so its night-sky dissolves into the live
  // world instead of hard-cutting.
  const [menuFading, setMenuFading] = useState(false);
  const fadeTimer = useRef(0);

  useEffect(() => {
    const engine = new Engine(canvasRef.current!, {
      onHud: (h) => set({ hud: h }),
      onLevelUp: (ch, lvl, banishes, rerolls) => set({ screen: 'levelup', choices: ch, newLevel: lvl, banishes, rerolls }),
      onGameOver: (r) => {
        const st = useGame.getState();
        const bonuses = computeBonuses(st.meta);
        const earned = dustForRun(r, bonuses);
        const next = {
          ...st.meta,
          dust: st.meta.dust + earned,
          shards: (st.meta.shards || 0) + (r.shards || 0),
          best: Math.max(st.meta.best || 0, Math.floor(r.time)),
        };
        saveMeta(next);
        engineRef.current!.inRun = false;
        set({ screen: 'dead', result: r, dustEarned: earned, meta: next });
      },
      getMeta: () => computeBonuses(useGame.getState().meta),
    });
    engineRef.current = engine;
    // seed synthesized-audio volumes from saved settings before the context opens
    audio.musicVol = settings.musicVol;
    audio.sfxVol = settings.sfxVol;
    engine.paused = true;
    engine.start();
    return () => {
      window.clearTimeout(fadeTimer.current);
      engine.stop();
    };
  }, [set]);

  const begin = () => {
    if (menuFading) return;
    const fromMenu = useGame.getState().screen === 'menu';
    audio.resume();
    engineRef.current!.reset();
    if (settings.devEndgame) engineRef.current!.devEndgame();
    engineRef.current!.inRun = true;
    engineRef.current!.paused = false;
    engineRef.current!.pushHud(true);
    set({ screen: 'playing', result: null });
    // only the main menu dissolves (retry from the death screen cuts straight in)
    if (fromMenu) {
      setMenuFading(true);
      window.clearTimeout(fadeTimer.current);
      fadeTimer.current = window.setTimeout(() => setMenuFading(false), 550);
    }
  };

  const resume = () => {
    engineRef.current!.paused = false;
    engineRef.current!.pushHud(true);
  };

  // Abandon the current run and return to the main menu. The engine stays paused
  // there; the next "Fall asleep" calls reset() to start a fresh dream.
  const returnToMenu = () => {
    engineRef.current!.paused = true;
    engineRef.current!.inRun = false;
    set({ screen: 'menu', result: null });
  };

  const pickChoice = (c: Choice) => {
    const more = engineRef.current!.chooseUpgrade(c);
    if (!more) set({ screen: 'playing' });
  };

  const renderOverlay = (s: Screen) => {
    if (s === 'settings') return <Settings key="settings" onClose={() => set({ screen: 'menu' })} />;
    if (s === 'dead' && result) return <GameOver key="dead" result={result} dustEarned={dustEarned} onRetry={begin} onTree={() => set({ screen: 'tree' })} />;
    if (s === 'tree') return (
      <SkillTree
        key="tree"
        meta={meta}
        onBuy={(id) => set({ meta: buyNode(useGame.getState().meta, id) })}
        onRefund={(id) => set({ meta: refundNode(useGame.getState().meta, id) })}
        onLoadout={(l) => set({ meta: setLoadout(useGame.getState().meta, l) })}
        onClose={() => set({ screen: useGame.getState().result ? 'dead' : 'menu' })}
      />
    );
    return null;
  };

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="game-canvas" />

      {screen === 'playing' && hud && <Hud hud={hud} />}
      {screen === 'playing' && hud && hud.paused && (
        <PauseMenu onResume={resume} onReturnToMenu={returnToMenu} />
      )}

      {screen === 'levelup' && (
        <LevelUp
          choices={choices}
          level={newLevel}
          banishes={banishes}
          rerolls={rerolls}
          showBanish={computeBonuses(meta).banish > 0}
          showReroll={computeBonuses(meta).reroll > 0}
          onPick={pickChoice}
          onBanish={(c) => engineRef.current!.banish(c)}
          onReroll={() => engineRef.current!.reroll()}
        />
      )}
      {/* rendered outside renderOverlay so the same element survives the
          screen flip to 'playing' — the opacity transition needs that */}
      {(screen === 'menu' || menuFading) && (
        <Menu
          key="menu"
          closing={menuFading}
          onStart={begin}
          meta={meta}
          onTree={() => set({ screen: 'tree' })}
          onSettings={() => set({ screen: 'settings' })}
        />
      )}
      {renderOverlay(screen)}
    </div>
  );
}

function Hud({ hud }: { hud: HudState }) {
  return (
    <>
      <div className="hud-top">
        <div className="bar-wrap">
          <div className="bar hp">
            <div className="fill" style={{ width: `${(100 * hud.hp) / hud.maxHp}%` }} />
            <span>{Math.ceil(hud.hp)} / {hud.maxHp}</span>
          </div>
          <div className="bar xp">
            <div className="fill" style={{ width: `${(100 * hud.xp) / hud.xpNext}%` }} />
            <span>Reverie {hud.level}</span>
          </div>
        </div>
        <div className="hud-center">
          <div className="clock">{fmtTime(hud.time)}</div>
          <div className="kills">{hud.kills} banished</div>
          <div className="dust-live">✦ {hud.dust}</div>
          {hud.shards > 0 && <div className="dust-live shards">❖ {hud.shards}</div>}
        </div>
      </div>
      <div className="hud-spells">
        {hud.spells.map((s) => (
          <div key={s.id} className={`spell-chip ${s.evolved ? 'evolved' : ''}`} style={{ '--c': SPELLS[s.id].color } as React.CSSProperties}>
            <span className="glyph"><SpellIcon id={s.id} size={19} /></span>
            <span className="lv">{s.evolved ? '★' : s.level}</span>
          </div>
        ))}
        {Array.from({ length: Math.max(0, (hud.spellCap || 6) - hud.spells.length) }).map((_, i) => (
          <div key={`empty-${i}`} className="spell-chip empty" title="Empty spell slot">
            <span className="glyph">+</span>
          </div>
        ))}
        {Object.entries(hud.boons).map(([id, lv]) => (
          <div key={id} className="spell-chip boon">
            <span className="glyph">{BOONS[id].icon}</span>
            <span className="lv">{lv}</span>
          </div>
        ))}
      </div>
      <div className="hint">WASD / arrows to drift — your spells cast themselves</div>
    </>
  );
}

function PauseMenu({ onResume, onReturnToMenu }: { onResume: () => void; onReturnToMenu: () => void }) {
  return (
    <div className="overlay pause-overlay">
      <div className="title-block">
        <div className="eyebrow">The dream holds still</div>
        <h1 className="pause-title">Paused</h1>
        <div className="menu-buttons">
          <button className="btn-primary" onClick={onResume}>Resume</button>
          <button className="btn-secondary" onClick={onReturnToMenu}>Return to main menu</button>
        </div>
        <div className="controls-hint">Press Esc to resume · returning to the menu ends this dream</div>
      </div>
    </div>
  );
}

function Menu({ onStart, onTree, onSettings, meta, closing }: {
  onStart: () => void; onTree: () => void; onSettings: () => void; meta: Meta;
  closing?: boolean;
}) {
  return (
    <div className={`overlay menu${closing ? ' closing' : ''}`}>
      <div className="menu-bg" aria-hidden="true" />
      <div className="title-block">
        <div className="eyebrow">A reverie survival</div>
        <h1>DREAMTIDE</h1>
        <p className="sub">
          You are the last magus awake inside a drowning dream. The tide brings
          wisps, shades and worse. Drift, survive, and let fourteen schools of
          magic bloom around you.
        </p>
        <div className="menu-buttons">
          <button className="btn-primary" onClick={onStart}>Fall asleep</button>
          <button className="btn-secondary" onClick={onTree}>
            ✦ Constellation
            <span className="dust-chip">✦ {meta.dust}{(meta.shards || 0) > 0 ? ` · ❖ ${meta.shards}` : ''}</span>
          </button>
          <button className="btn-secondary" onClick={onSettings}>⚙ Settings</button>
          {isNative && (
            <button className="btn-secondary" onClick={exitApp}>Exit</button>
          )}
        </div>
        <div className="controls-hint">Move with WASD or arrow keys · spells are cast automatically · choose wisely when you level</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- settings
const PRESETS: Preset[] = ['low', 'medium', 'high', 'unlimited'];
const PRESET_LABEL: Record<Preset, string> = { low: 'Low', medium: 'Medium', high: 'High', unlimited: 'Unlimited' };

// A row of preset buttons for one performance knob.
function PresetRow({ label, hint, value, onPick }: {
  label: string; hint: string; value: Preset; onPick: (p: Preset) => void;
}) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span className="set-name">{label}</span>
        <span className="set-hint">{hint}</span>
      </div>
      <div className="preset-group">
        {PRESETS.map((p) => (
          <button
            key={p}
            className={`preset-btn ${value === p ? 'active' : ''}`}
            onClick={() => onPick(p)}
          >
            {PRESET_LABEL[p]}
          </button>
        ))}
      </div>
    </div>
  );
}

function VolumeRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="set-row">
      <div className="set-label"><span className="set-name">{label}</span></div>
      <div className="vol-control">
        <input
          className="vol-slider"
          type="range" min={0} max={100} step={1}
          value={Math.round(value * 100)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
        />
        <span className="vol-num">{Math.round(value * 100)}%</span>
      </div>
    </div>
  );
}

function Settings({ onClose }: { onClose: () => void }) {
  // local mirror so the sliders/buttons re-render; the settings singleton is
  // the source of truth and persists each change.
  const [music, setMusic] = useState(settings.musicVol);
  const [sfx, setSfx] = useState(settings.sfxVol);
  const [perf, setPerf] = useState<PerfPresets>({ ...settings.perf });
  const [res, setRes] = useState<ResolutionScale>(settings.resolution);
  const [dev, setDev] = useState(settings.devEndgame);

  const changeMusic = (v: number) => { settings.setMusicVol(v); audio.setMusicVolume(v); setMusic(v); };
  const changeSfx = (v: number) => { settings.setSfxVol(v); audio.setSfxVolume(v); setSfx(v); };
  const changePerf = (k: keyof PerfPresets, p: Preset) => { settings.setPerf(k, p); setPerf({ ...settings.perf }); };
  const changeRes = (v: ResolutionScale) => { settings.setResolution(v); setRes(v); };
  const changeDev = (v: boolean) => { settings.setDevEndgame(v); setDev(v); };
  const resetDefaults = () => {
    settings.resetDefaults();
    audio.setMusicVolume(settings.musicVol);
    audio.setSfxVolume(settings.sfxVol);
    setMusic(settings.musicVol);
    setSfx(settings.sfxVol);
    setPerf({ ...settings.perf });
    setRes(settings.resolution);
    setDev(settings.devEndgame);
  };

  return (
    <div className="overlay settings-overlay">
      <div className="settings-panel">
        <div className="settings-head">
          <div>
            <div className="eyebrow">Settings</div>
            <h2 className="settings-title">Tune the dream</h2>
          </div>
          <div className="settings-head-actions">
            <button className="btn-secondary" onClick={resetDefaults}>Reset to defaults</button>
            <button className="btn-secondary" onClick={onClose}>Return</button>
          </div>
        </div>

        <div className="settings-scroll">
          <section className="set-section">
            <h3 className="set-heading">Audio</h3>
            <VolumeRow label="Music" value={music} onChange={changeMusic} />
            <VolumeRow label="Sounds" value={sfx} onChange={changeSfx} />
          </section>

          <section className="set-section">
            <h3 className="set-heading">Performance</h3>
            <p className="set-note">Lower settings ease strain in the late-game swarm. Medium is the default.</p>
            <PresetRow label="Particles" hint="Density of the cosmetic dream-motes" value={perf.particles} onPick={(p) => changePerf('particles', p)} />
            <PresetRow label="Damage numbers" hint="How many floating numbers show at once" value={perf.dmgText} onPick={(p) => changePerf('dmgText', p)} />
            <PresetRow label="Enemy health bars" hint="How many bars draw at once" value={perf.hpBars} onPick={(p) => changePerf('hpBars', p)} />
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">Resolution</span>
                <span className="set-hint">Render scale of the world layer</span>
              </div>
              <div className="preset-group">
                {RESOLUTION_OPTIONS.map((v) => (
                  <button
                    key={v}
                    className={`preset-btn ${res === v ? 'active' : ''}`}
                    onClick={() => changeRes(v)}
                  >
                    {Math.round(v * 100)}%
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="set-section dev-section">
            <h3 className="set-heading">Dev only</h3>
            <label className="dev-toggle">
              <input type="checkbox" checked={dev} onChange={(e) => changeDev(e.target.checked)} />
              ⚗ endgame test — start at 6:00 with a full random loadout (lv 5 / evolved)
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}

function LevelUp({ choices, level, banishes, rerolls, showBanish, showReroll, onPick, onBanish, onReroll }: {
  choices: Choice[]; level: number; banishes: number; rerolls: number;
  showBanish: boolean; showReroll: boolean;
  onPick: (c: Choice) => void; onBanish: (c: Choice) => void; onReroll: () => void;
}) {
  const [banishing, setBanishing] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [deal, setDeal] = useState(0);
  const busy = banishing != null || rolling;
  const picked = useRef(false);
  const handSig = `${level}:${choices.map((c) => `${c.kind}:${c.id}`).join(',')}`;
  const lastSig = useRef(handSig);
  if (handSig !== lastSig.current) { lastSig.current = handSig; picked.current = false; }
  const pick = (c: Choice) => {
    if (picked.current || busy) return;
    picked.current = true;
    onPick(c);
  };
  const doBanish = (c: Choice, i: number) => {
    if (busy) return;
    setBanishing(i);
    setTimeout(() => { onBanish(c); setBanishing(null); }, 480);
  };
  const doReroll = () => {
    if (busy || rerolls <= 0) return;
    setRolling(true);
    setTimeout(() => { onReroll(); setDeal((d) => d + 1); setRolling(false); }, 420);
  };
  return (
    <div className="overlay levelup">
      <div className="eyebrow">Reverie deepens</div>
      <h2>Level {level}</h2>
      <div className={`cards ${rolling ? 'rolling' : ''}`} key={deal}>
        {choices.map((c, i) => {
          const isEvolve = c.kind === 'evolve';
          const isSpell = c.kind === 'spell' || isEvolve;
          const def = isSpell ? SPELLS[c.id] : c.kind === 'boon' ? BOONS[c.id] : GENERIC[c.id];
          const spellDef = isSpell ? SPELLS[c.id] : null;
          return (
            <div key={`${c.kind}-${c.id}-${i}`} className={`card-slot ${banishing === i ? 'banishing' : ''}`}>
              <button
                className={`card ${isEvolve ? 'evolve' : isSpell ? 'spell' : 'boon'}`}
                style={(isSpell && spellDef ? { '--c': spellDef.color, '--c2': spellDef.color2 } : { '--c': '#ffd27a', '--c2': '#fff2cc' }) as React.CSSProperties}
                onClick={() => pick(c)}
              >
                <div className="card-glyph">{isSpell && HAS_ICON(c.id) ? <SpellIcon id={c.id} size={40} /> : def.icon}</div>
                <div className="card-name">{isEvolve ? EVOLVE[c.id].name : def.name}</div>
                <div className="card-school">
                  <span>{isEvolve ? spellDef!.school : isSpell ? spellDef!.school : c.kind === 'generic' ? 'Amplify' : 'Boon'}</span>
                  <span>{isEvolve ? 'Evolution' : isSpell ? (c.isNew ? 'New spell' : c.mastery ? `Mastery ${c.level}` : `Level ${c.level}`) : `Rank ${c.level}`}</span>
                </div>
                <div className="card-desc">
                  {isEvolve ? EVOLVE[c.id].desc : c.kind === 'generic' ? def.desc : (isSpell ? (c.isNew ? spellDef!.desc : c.mastery ? 'Pure damage — the dream deepens beyond its limits.' : spellDef!.levelText(c.level!)) : def.desc)}
                </div>
              </button>
              {showBanish && (
                <button
                  className="banish-btn"
                  disabled={banishes <= 0 || banishing != null}
                  title="Banish: never see this again this dream"
                  onClick={() => doBanish(c, i)}
                >
                  ✕ banish
                </button>
              )}
            </div>
          );
        })}
      </div>
      {(showBanish || showReroll) && (
        <div className="levelup-tools">
          {showReroll && (
            <button
              className="reroll-btn"
              disabled={rerolls <= 0 || busy}
              title="Reroll: scatter these choices and dream up new ones"
              onClick={doReroll}
            >
              ⟳ reroll the dream
            </button>
          )}
          <div className="banish-count">
            {[
              showBanish ? `${banishes} banish${banishes === 1 ? '' : 'es'}` : null,
              showReroll ? `${rerolls} reroll${rerolls === 1 ? '' : 's'}` : null,
            ].filter(Boolean).join(' · ')} left this dream
          </div>
        </div>
      )}
    </div>
  );
}

function GameOver({ result, dustEarned, onRetry, onTree }: {
  result: RunResult; dustEarned: number; onRetry: () => void; onTree: () => void;
}) {
  return (
    <div className="overlay dead">
      <div className="eyebrow">The dream closes over you</div>
      <h2>You wake</h2>
      <div className="result-row">
        <div><span className="num">{fmtTime(result.time)}</span><span className="lbl">survived</span></div>
        <div><span className="num">{result.kills}</span><span className="lbl">banished</span></div>
        <div><span className="num">{result.level}</span><span className="lbl">reverie</span></div>
        <div><span className="num dust">+{dustEarned}</span><span className="lbl">stardust</span></div>
        {(result.shards || 0) > 0 && <div><span className="num shards">+{result.shards}</span><span className="lbl">shards</span></div>}
      </div>
      <div className="menu-buttons">
        <button className="btn-primary" onClick={onRetry}>Sleep again</button>
        <button className="btn-secondary" onClick={onTree}>✦ Constellation</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- skill tree
const KIND_R: Record<string, number> = { core: 16, small: 9, notable: 13, keystone: 17 };
const KIND_ICON_SIZE: Record<string, number> = { core: 15, small: 9.5, notable: 13, keystone: 15 };

// nodes that display a bare spell glyph → render the SVG icon instead (the raw
// alchemical Unicode has no cross-platform coverage). Returns the spell id, else null.
function nodeSpellIconId(n: TreeNode): string | null {
  const fx = n.fx || {};
  if (n.kind === 'core' || n.currency === 'shards') return null;
  if (fx.spell && !fx.evo && !fx.sdmg && !fx.scd && !fx.saoe && !fx.sdur && HAS_ICON(fx.spell)) return fx.spell;
  return null;
}

function nodeIcon(n: TreeNode): string {
  const fx = n.fx || {};
  if (n.kind === 'core') return '☉';
  if (n.currency === 'shards') return '❖';
  if (fx.spell) {
    if (fx.evo) return '★';
    if (fx.sdmg) return '✦';
    if (fx.scd) return '≋';
    if (fx.saoe) return '◎';
    if (fx.sdur) return '◷';
    return SPELLS[fx.spell].icon;
  }
  const ICONS: [string, string][] = [
    ['banish', '✕'], ['reroll', '⟳'], ['fourfold', '✥'],
    ['spellSlots', '▣'], ['extraCount', '✚'], ['echo', '⧉'], ['masteryPlus', '⇑'], ['startLv', '✬'],
    ['cheatDeath', '♥'], ['deathBurst', '✺'],
    ['gemMerge', '⬢'], ['golden', '✯'], ['extraGem', '❂'],
    ['surgeAll', '∿'], ['surgeDur', '∿'], ['surgeSpeed', '➳'], ['surgeDmg', '✦'],
    ['surgeHaste', '≋'], ['surgeAoe', '◎'], ['surgeMagnet', '◉'],
    ['crit', '✸'], ['critDmg', '✸'],
    ['dmg', '✦'], ['cast', '≋'], ['aoe', '◎'], ['speed', '➳'],
    ['hp', '❤'], ['regen', '☽'], ['magnet', '◉'], ['xp', '❂'], ['dust', '✧'],
  ];
  for (const [k, ic] of ICONS) if (fx[k]) return ic;
  return '';
}

const TREE_VIEW = 2480;

interface EdgeGeom { a: string; b: string; dark: boolean; d: string | null; line: { x1: number; y1: number; x2: number; y2: number } | null }

const EDGE_GEOM: EdgeGeom[] = TREE_EDGES.map(([a, b, bend]) => {
  const na = NODE_MAP[a], nb = NODE_MAP[b];
  if (!na || !nb) return null;
  const dark = a.startsWith('dark-') && b.startsWith('dark-');
  let d: string | null = null, line: EdgeGeom['line'] = null;
  if (!bend) {
    line = { x1: na.x, y1: na.y, x2: nb.x, y2: nb.y };
  } else {
    const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
    const dx = nb.x - na.x, dy = nb.y - na.y;
    const len = Math.hypot(dx, dy) || 1;
    const cx = mx + (-dy / len) * bend, cy = my + (dx / len) * bend;
    d = `M ${na.x} ${na.y} Q ${cx} ${cy} ${nb.x} ${nb.y}`;
  }
  return { a, b, dark, d, line };
}).filter(Boolean) as EdgeGeom[];

const TreeEdges = React.memo(function TreeEdges({ owned }: { owned: Set<string> }) {
  return (
    <>
      {EDGE_GEOM.map((e, i) => {
        const lit = owned.has(e.a) && owned.has(e.b);
        const half = !lit && (owned.has(e.a) || owned.has(e.b));
        const cls = `tree-edge ${e.dark ? 'dark ' : ''}${lit ? 'lit' : half ? 'half' : ''}`;
        return e.line
          ? <line key={i} x1={e.line.x1} y1={e.line.y1} x2={e.line.x2} y2={e.line.y2} className={cls} />
          : <path key={i} d={e.d!} className={cls} />;
      })}
    </>
  );
});

function SkillTree({ meta, onBuy, onRefund, onLoadout, onClose }: {
  meta: Meta; onBuy: (id: string) => void; onRefund: (id: string) => void;
  onLoadout: (loadout: string[]) => void; onClose: () => void;
}) {
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  // one-shot allocation pulse: { id, key } — key bumps each buy so re-buying the
  // same node (after a refund) retriggers the CSS animation. Cleared after the
  // animation ends so only ever one node animates, briefly.
  const [pulse, setPulse] = useState<{ id: string; key: number } | null>(null);
  const pulseKey = useRef(0);
  const pulseTimer = useRef(0);
  const viewRef = useRef(view);
  const gRef = useRef<SVGGElement>(null);
  const rafRef = useRef(0);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const owned = useMemo(() => new Set(meta.owned), [meta.owned]);
  const node = tip ? NODE_MAP[tip.id] : null;

  // Write the transform at most once per frame. Panning mutates the SVG group's
  // transform, which re-rasterizes the whole subtree; coalescing many mousemoves
  // into one rAF write avoids redundant repaints. (Per-node drop-shadow glows
  // were also removed from the styles — they made a 356-node pan stutter.)
  const applyTransform = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const vv = viewRef.current;
      if (gRef.current) gRef.current.setAttribute('transform', `translate(${vv.x} ${vv.y}) scale(${vv.z})`);
    });
  };

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
  }, []);

  // trigger the one-shot allocation pulse on a node, auto-removing it when the
  // CSS animation finishes (keeps exactly one node animated for ~0.7s max).
  const firePulse = (id: string) => {
    pulseKey.current += 1;
    setPulse({ id, key: pulseKey.current });
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setPulse(null), 750);
  };

  const hover = (n: TreeNode) => (e: React.MouseEvent) => {
    if (dragRef.current && dragRef.current.moved) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    setTip({ id: n.id, x: r.left + r.width / 2, y: r.top });
  };

  const onWheel = (e: React.WheelEvent) => {
    const v = viewRef.current;
    const z = Math.min(3.2, Math.max(0.55, v.z * (e.deltaY < 0 ? 1.15 : 0.87)));
    const next = { ...v, z };
    viewRef.current = next;
    applyTransform();
    setView(next);
  };
  const onMouseDown = (e: React.MouseEvent) => {
    const v = viewRef.current;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) {
      if (!d.moved) setTip(null);
      d.moved = true;
    }
    if (!d.moved) return;
    const k = TREE_VIEW / (e.currentTarget as SVGSVGElement).clientWidth;
    const next = { x: d.ox + dx * k, y: d.oy + dy * k, z: viewRef.current.z };
    viewRef.current = next;
    applyTransform();
  };
  const endDrag = () => {
    const d = dragRef.current;
    if (d && d.moved) setView(viewRef.current);
    setTimeout(() => { dragRef.current = null; }, 0);
  };
  const wasDrag = () => dragRef.current && dragRef.current.moved;

  return (
    <div className="overlay tree-overlay">
      <div className="tree-bg" aria-hidden="true" />
      <div className="tree-head">
        <div>
          <div className="eyebrow">The Constellation</div>
          <div className="tree-sub">Drag to pan, scroll to zoom. Hover a star to read it; click to awaken it — or click an awakened star to release it for half its stardust.</div>
        </div>
        <div className="tree-progress">{meta.owned.length - 1}/{TREE_NODES.length - 1}</div>
        <div className="dust-big">✦ {meta.dust}</div>
        <div className="dust-big shards" title="Nightmare shards — torn from slain bosses, they feed the Dark Bargain">❖ {meta.shards || 0}</div>
        <button className="btn-secondary" onClick={onClose}>Return</button>
      </div>

      <div className="tree-scroll">
        <svg
          viewBox={`${-TREE_VIEW / 2} ${-TREE_VIEW / 2} ${TREE_VIEW} ${TREE_VIEW}`}
          className="tree-svg"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
        >
          <g ref={gRef} transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
            <TreeEdges owned={owned} />
            {TREE_NODES.map((n) => {
              const isOwned = owned.has(n.id);
              const buyable = canBuy(meta, n.id);
              const reach = isReachable(meta, n.id);
              const refundable = isOwned && canRefund(meta, n.id);
              const r = KIND_R[n.kind] || 9;
              return (
                <g
                  key={n.id}
                  className={`tree-node ${n.kind} ${n.currency === 'shards' ? 'dark' : ''} ${isOwned ? 'owned' : buyable ? 'buyable' : reach ? 'reach' : 'locked'} ${refundable ? 'refundable' : ''}`}
                  transform={`translate(${n.x},${n.y})`}
                  onMouseEnter={hover(n)}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => {
                    if (wasDrag()) return;
                    if (buyable) { onBuy(n.id); firePulse(n.id); audio.choose(); }
                    else if (refundable) { onRefund(n.id); audio.voidCast(); }
                  }}
                >
                  {pulse && pulse.id === n.id && (
                    <circle key={pulse.key} className="node-pulse" r={r} />
                  )}
                  <circle className="halo" r={r + 7} />
                  <circle className="body" r={r} />
                  {n.kind === 'keystone' && <circle className="inner" r={r * 0.72} />}
                  {(() => {
                    const sid = nodeSpellIconId(n);
                    if (sid) {
                      // sized to sit comfortably inside the node with breathing room
                      const s = (KIND_R[n.kind] || 9) * 1.55;
                      // nested SVG centred on the node; inherits fill via .node-icon color
                      return (
                        <svg className="node-icon svg" x={-s / 2} y={-s / 2} width={s} height={s} viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
                          <SpellIconInner id={sid} />
                        </svg>
                      );
                    }
                    return <text className="node-icon" fontSize={KIND_ICON_SIZE[n.kind] || 9.5}>{nodeIcon(n)}</text>;
                  })()}
                </g>
              );
            })}
            {CLUSTER_INFO.map((c) => {
              const got = c.ids.filter((id) => owned.has(id)).length;
              return (
                <g key={c.spell} className="cluster-label" transform={`translate(${c.cx},${c.cy + 158})`}>
                  <text className="cluster-name" style={{ fill: c.color }}>{c.name}</text>
                  <text className="cluster-count" y="24">{got}/{c.ids.length}</text>
                </g>
              );
            })}
          </g>
        </svg>

        {node && tip && (
          <div className="node-tip" style={{ left: tip.x, top: tip.y }}>
            <div className="tip-name">
              {node.name}
              <span className={`tip-kind ${node.kind}`}>{node.kind === 'core' ? 'origin' : node.kind}</span>
            </div>
            <div className="tip-desc">{node.desc}</div>
            {owned.has(node.id) ? (
              <div className="tip-owned">
                ✓ awakened
                {node.id !== 'core' && (
                  canRefund(meta, node.id)
                    ? <span className="tip-refund"> · click to release for {node.currency === 'shards' ? '❖' : '✦'} {refundValue(node.id)}</span>
                    : <span className="tip-locked"> · other stars depend on this one</span>
                )}
              </div>
            ) : (
              <div className="tip-row">
                <span className={`tip-cost ${node.currency === 'shards' ? 'shards' : ''}`}>{node.currency === 'shards' ? '❖' : '✦'} {node.cost}</span>
                {canBuy(meta, node.id) ? (
                  <span className="tip-hint">click to awaken</span>
                ) : (
                  <span className="tip-locked">
                    {isReachable(meta, node.id)
                      ? (node.currency === 'shards' ? 'not enough nightmare shards — bosses drop them' : 'not enough stardust')
                      : 'connect the path first'}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <LoadoutBar meta={meta} onLoadout={onLoadout} />
    </div>
  );
}

// The loadout: which spells the player carries into every run. One slot by
// default (Arcane Missiles); +1-slot notables add slots up to MAX_LOADOUT. Each
// slot is a picker over the unlocked spells; picking the blank clears the slot.
function LoadoutBar({ meta, onLoadout }: { meta: Meta; onLoadout: (l: string[]) => void }) {
  const slots = loadoutSlots(meta);
  const unlocked = unlockedSpells(meta);
  const loadout = meta.loadout;
  const [open, setOpen] = useState<number | null>(null);

  // set slot `i` to spell `id` (or clear if null), keeping the array compact and
  // free of duplicates. Slot 0 always keeps a spell (falls back to Arcane).
  const choose = (i: number, id: string | null) => {
    const next = [...loadout];
    if (id) {
      // if the spell is already elsewhere, swap it out of there
      const at = next.indexOf(id);
      if (at >= 0 && at !== i) next.splice(at, 1);
    }
    if (id === null) next.splice(i, 1);
    else next[i] = id;
    onLoadout(next);
    setOpen(null);
  };

  return (
    <div className="loadout">
      <div className="loadout-label">Loadout <span className="loadout-hint">— spells you begin every dream with</span></div>
      <div className="loadout-slots">
        {Array.from({ length: slots }, (_, i) => {
          const id = loadout[i];
          const sp = id ? SPELLS[id] : null;
          const canClear = i > 0; // slot 0 must always hold a spell
          return (
            <div key={i} className="loadout-slot-wrap">
              <button
                className={`loadout-slot ${sp ? 'filled' : 'empty'}`}
                style={sp ? ({ '--c': sp.color } as React.CSSProperties) : undefined}
                onClick={() => setOpen(open === i ? null : i)}
                title={sp ? sp.name : 'empty slot — click to choose a spell'}
              >
                <span className="ls-glyph">{sp ? <SpellIcon id={id} size={26} /> : '+'}</span>
              </button>
              {open === i && (
                <div className="loadout-menu">
                  {canClear && (
                    <button className="lm-item empty" onClick={() => choose(i, null)}>✕ empty</button>
                  )}
                  {unlocked
                    // only spells not already placed in another slot (the one in
                    // THIS slot stays, shown as active)
                    .filter((uid) => uid === loadout[i] || !loadout.includes(uid))
                    .map((uid) => (
                      <button
                        key={uid}
                        className={`lm-item ${loadout[i] === uid ? 'active' : ''}`}
                        style={{ '--c': SPELLS[uid].color } as React.CSSProperties}
                        onClick={() => choose(i, uid)}
                      >
                        <span className="lm-glyph"><SpellIcon id={uid} size={18} /></span>
                        <span className="lm-name">{SPELLS[uid].name}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          );
        })}
        {slots < 4 && (
          <div className="loadout-locked" title="Awaken +1 spell slot notables to widen your loadout">
            {Array.from({ length: 4 - slots }, (_, i) => <span key={i} className="ls-lock">🔒</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
