import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Engine, type HudState, type Choice } from './game/engine';
import { SPELLS, BOONS, GENERIC, EVOLVE } from './game/spells';
import { RELICS, PACTS, type PactDef } from './game/relics';
import { SpellIcon, HAS_ICON } from './game/spellIcons';
import { codex, REACTIONS } from './game/codex';
import { audio } from './game/audio';
import { settings, RESOLUTION_OPTIONS, hdrSupported, watchHdrSupport, type Preset, type PerfPresets, type ResolutionScale } from './game/settings';
import { isNative, exitApp } from './game/nativeWindow';
import {
  CONST_NODES, CONST_EDGES, DARK_NODES, DARK_EDGES, NODE_MAP, ADJACENT,
  loadMeta, saveMeta, computeBonuses, dustForRun, setLoadout, loadoutSlots, unlockedSpells,
  setSkin, unlockedSkins, recordClear, CLEAR_SKINS,
  markTreeRevealed, markDarkRevealed,
  nextPointCost, nextDarkPointCost, canBuyPoint, buyPoint, canBuyDarkPoint, buyDarkPoint,
  allocateNode, deallocateNode, allocateAllLight, resetAllLight, removableSet, darkDepth,
  type Meta,
} from './game/meta';
import { WIZARD_SKINS, skinName, skinColor, applySkin } from './game/wizardSkins';
import { paintWizardPreview, type WizardSkin } from './game/enemySprites';
import { TreeCanvas, type TreePhase } from './game/treeCanvas';

type Screen = 'menu' | 'playing' | 'levelup' | 'relic' | 'pact' | 'dead' | 'won' | 'tree' | 'dark' | 'settings' | 'book';

interface RunResult { time: number; kills: number; level: number; bonusDust: number; shards: number; relics: string[]; record?: boolean; cleared?: boolean }
interface VictoryInfo { time: number; kills: number; level: number; relics: string[]; firstClear: boolean; cleared: number; clearBest: number }

interface GameStore {
  screen: Screen;
  hud: HudState | null;
  choices: Choice[];
  newLevel: number;
  banishes: number;
  rerolls: number;
  relicChoices: string[];
  pactOffer: PactDef | null;
  result: RunResult | null;
  victory: VictoryInfo | null;
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
  relicChoices: [],
  pactOffer: null,
  result: null,
  victory: null,
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

// The night-sky layers (rising motes, twinkling stars) are CSS animations, and
// every screen mounts its own copy — a fresh mount would restart them from
// frame zero, visibly "resetting" the sky when switching menu ↔ settings ↔ tree.
// A negative animation-delay equal to the app's age makes each mount resume
// mid-cycle exactly where a continuously-running sky would be.
// MUST be captured once per mount (useSkyState): recomputed on every render it
// slides the animation phase forward by the component's age, so each button
// click / slider tick visibly skips the sky ahead and desyncs it from the
// other screens' skies.
const skyState = () => ({ '--sky-delay': `-${(performance.now() / 1000).toFixed(2)}s` } as React.CSSProperties);
function useSkyState() { return useMemo(skyState, []); }

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  // Per-field selectors, deliberately NOT the whole store: hud updates flow at
  // gameplay cadence and must only re-render HudLayer below, never this whole
  // component tree (that churn would be a steady GC feed during play).
  const screen = useGame((s) => s.screen);
  const choices = useGame((s) => s.choices);
  const newLevel = useGame((s) => s.newLevel);
  const banishes = useGame((s) => s.banishes);
  const rerolls = useGame((s) => s.rerolls);
  const relicChoices = useGame((s) => s.relicChoices);
  const pactOffer = useGame((s) => s.pactOffer);
  const result = useGame((s) => s.result);
  const victory = useGame((s) => s.victory);
  const dustEarned = useGame((s) => s.dustEarned);
  const meta = useGame((s) => s.meta);
  const set = useGame((s) => s.set);
  // menu → run cross-fade: the run starts immediately, but the menu stays
  // mounted with a `closing` class so its night-sky dissolves into the live
  // world instead of hard-cutting.
  const [menuFading, setMenuFading] = useState(false);
  const fadeTimer = useRef(0);

  useEffect(() => {
    const engine = new Engine(canvasRef.current!, {
      onHud: (h) => set({ hud: h }),
      onLevelUp: (ch, lvl, banishes, rerolls) => set({ screen: 'levelup', choices: ch, newLevel: lvl, banishes, rerolls }),
      onRelic: (ids) => set({ screen: 'relic', relicChoices: ids }),
      onPact: (pact) => set({ screen: 'pact', pactOffer: pact }),
      onGameOver: (r) => {
        const st = useGame.getState();
        const bonuses = computeBonuses(st.meta);
        const earned = dustForRun(r, bonuses);
        // a personal record only counts once a previous best exists to beat
        const record = (st.meta.best || 0) > 0 && Math.floor(r.time) > (st.meta.best || 0);
        const next = {
          ...st.meta,
          dust: st.meta.dust + earned,
          shards: (st.meta.shards || 0) + (r.shards || 0),
          best: Math.max(st.meta.best || 0, Math.floor(r.time)),
        };
        saveMeta(next);
        engineRef.current!.inRun = false;
        set({ screen: 'dead', result: { ...r, record }, dustEarned: earned, meta: next });
      },
      onVictory: (r) => {
        const st = useGame.getState();
        const firstClear = (st.meta.cleared || 0) === 0;
        const next = recordClear(st.meta, r.time);
        set({ screen: 'won', victory: { ...r, firstClear, cleared: next.cleared, clearBest: next.clearBest }, meta: next });
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

  // Tactile UI, delegated so every button in the app gets it: a whisper of a
  // tick on hover, a soft pluck on press. The pointerdown is also the user
  // gesture that opens the AudioContext, so the menu ambience starts breathing
  // on the very first interaction.
  useEffect(() => {
    // Try to open the audio context right away. On the Tauri desktop build
    // (WebView2 launched with --autoplay-policy=no-user-gesture-required) this
    // starts the menu ambience instantly; in the browser it stays suspended
    // and the first pointerdown below resumes it, per autoplay policy.
    audio.resume();
    const onDown = (ev: PointerEvent) => {
      audio.userGesture();
      if ((ev.target as HTMLElement).closest?.('button')) audio.uiClick();
    };
    const onOver = (ev: MouseEvent) => {
      const btn = (ev.target as HTMLElement).closest?.('button');
      const from = (ev.relatedTarget as HTMLElement | null)?.closest?.('button');
      if (btn && btn !== from) audio.uiHover();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('mouseover', onOver, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('mouseover', onOver, true);
    };
  }, []);

  // the chosen vestment recolors the wizard's sheet in the sprite atlas; the
  // GPU renderer picks the repaint up on its next frame
  useEffect(() => { applySkin(meta.skin); }, [meta.skin]);

  const begin = () => {
    if (menuFading) return;
    const fromMenu = useGame.getState().screen === 'menu';
    audio.resume();
    audio.runStart();
    engineRef.current!.reset();
    if (settings.devFinale) engineRef.current!.devEndgame(890, 18);
    else if (settings.devEndgame) engineRef.current!.devEndgame();
    engineRef.current!.inRun = true;
    engineRef.current!.paused = false;
    engineRef.current!.pushHud(true);
    set({ screen: 'playing', result: null, victory: null });
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

  // dream on: the wake-rite closes and the (now endless) run continues
  const dreamOn = () => {
    set({ screen: 'playing', victory: null });
    engineRef.current!.paused = false;
    engineRef.current!.pushHud(true);
  };

  // Abandon the current run and return to the main menu. The engine stays paused
  // there; the next "Fall asleep" calls reset() to start a fresh dream.
  const returnToMenu = () => {
    engineRef.current!.paused = true;
    engineRef.current!.inRun = false;
    audio.menuMood();
    set({ screen: 'menu', result: null, victory: null });
  };

  const pickChoice = (c: Choice) => {
    const more = engineRef.current!.chooseUpgrade(c);
    if (!more) set({ screen: 'playing' });
  };

  const pickRelic = (id: string) => {
    engineRef.current!.chooseRelic(id);
    // the engine may immediately open a queued level-up; only fall back to
    // playing if it didn't flip the screen through its hook
    if (useGame.getState().screen === 'relic') set({ screen: 'playing', relicChoices: [] });
    else set({ relicChoices: [] });
  };

  const answerPact = (accept: boolean) => {
    engineRef.current!.resolvePact(accept);
    if (useGame.getState().screen === 'pact') set({ screen: 'playing', pactOffer: null });
    else set({ pactOffer: null });
  };

  const renderOverlay = (s: Screen) => {
    if (s === 'settings') return <Settings key="settings" onClose={() => set({ screen: 'menu' })} />;
    if (s === 'book') return <DreamBook key="book" onClose={() => set({ screen: useGame.getState().result ? 'dead' : 'menu' })} />;
    if (s === 'won' && victory) return <Victory key="won" victory={victory} onDreamOn={dreamOn} />;
    if (s === 'dead' && result) return <GameOver key="dead" result={result} dustEarned={dustEarned} meta={meta} onRetry={begin} onTree={() => set({ screen: 'tree' })} onDark={() => set({ screen: 'dark' })} onBook={() => set({ screen: 'book' })} onMenu={() => { audio.menuMood(); set({ screen: 'menu', result: null }); }} />;
    if (s === 'tree') return (
      <SkillTree
        key="tree"
        meta={meta}
        reveal={!meta.treeRevealed}
        onRevealed={() => set({ meta: markTreeRevealed(useGame.getState().meta) })}
        onMeta={(m) => set({ meta: m })}
        onLoadout={(l) => set({ meta: setLoadout(useGame.getState().meta, l) })}
        onSkin={(id) => set({ meta: setSkin(useGame.getState().meta, id) })}
        onClose={() => set({ screen: useGame.getState().result ? 'dead' : 'menu' })}
      />
    );
    if (s === 'dark') return (
      <DarkBargain
        key="dark"
        meta={meta}
        reveal={!meta.darkRevealed}
        onRevealed={() => set({ meta: markDarkRevealed(useGame.getState().meta) })}
        onMeta={(m) => set({ meta: m })}
        onClose={() => set({ screen: useGame.getState().result ? 'dead' : 'menu' })}
      />
    );
    return null;
  };

  return (
    <div className="stage">
      <canvas ref={canvasRef} className="game-canvas" />

      {screen === 'playing' && <HudLayer onResume={resume} onReturnToMenu={returnToMenu} />}

      {screen === 'levelup' && (() => {
        const bon = computeBonuses(meta);
        return (
          <LevelUp
            choices={choices}
            level={newLevel}
            banishes={banishes}
            rerolls={rerolls}
            showBanish={bon.banish > 0}
            showReroll={bon.reroll > 0}
            masteryPer={8 + (bon.masteryPlus || 0)}
            onPick={pickChoice}
            onBanish={(c) => engineRef.current!.banish(c)}
            onReroll={() => engineRef.current!.reroll()}
          />
        );
      })()}
      {screen === 'relic' && relicChoices.length > 0 && (
        <RelicChoice choices={relicChoices} onPick={pickRelic} />
      )}
      {screen === 'pact' && pactOffer && (
        <PactChoice pact={pactOffer} onAnswer={answerPact} />
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
          onDark={() => set({ screen: 'dark' })}
          onBook={() => set({ screen: 'book' })}
          onSettings={() => set({ screen: 'settings' })}
        />
      )}
      {renderOverlay(screen)}
    </div>
  );
}

// The only component subscribed to `hud`: engine pushes land here and re-render
// just this subtree. The engine also skips pushes whose displayed values are
// unchanged (see pushHud), so during quiet play this renders ~1×/s, not 10×.
function HudLayer({ onResume, onReturnToMenu }: { onResume: () => void; onReturnToMenu: () => void }) {
  const hud = useGame((s) => s.hud);
  // Settings can be opened from within the pause menu without leaving the dream.
  // Unpausing (or abandoning) always drops it, so a later pause opens clean.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const paused = hud?.paused;
  useEffect(() => { if (!paused) setSettingsOpen(false); }, [paused]);
  if (!hud) return null;
  return (
    <>
      <Hud hud={hud} />
      {hud.paused && !settingsOpen && (
        <PauseMenu onResume={onResume} onReturnToMenu={onReturnToMenu} onSettings={() => setSettingsOpen(true)} />
      )}
      {hud.paused && settingsOpen && <Settings onClose={() => setSettingsOpen(false)} extraClass="pause-settings" />}
    </>
  );
}

// A pure-CSS hover card carried inside each dock chip: its name, a small kind
// tag, and a description. Reveals on hover (the dock rides above the pause veil,
// so it can be read there too).
function ChipTip({ name, kind, desc }: { name: string; kind?: string; desc?: string }) {
  return (
    <span className="chip-tip" aria-hidden="true">
      <span className="chip-tip-head">{name}{kind && <em>{kind}</em>}</span>
      {desc && <span className="chip-tip-desc">{desc}</span>}
    </span>
  );
}

function Hud({ hud }: { hud: HudState }) {
  const boons = Object.entries(hud.boons);
  // The opening whisper appears only while it's useful: on the first dream
  // (no recorded best yet), and only for the first moments of it.
  const [firstDream] = useState(() => (useGame.getState().meta.best || 0) === 0);
  const coachGone = hud.time > 11 || hud.level > 1;
  return (
    <>
      <div className="xp-strip" title={`Reverie ${hud.level}`}>
        <div className="fill" style={{ width: `${(100 * hud.xp) / hud.xpNext}%` }} />
      </div>
      <div className="hud-top">
        <div className="hud-left">
          <div className="level-gem" title={`Reverie ${hud.level} — the strip above fills toward the next`}>
            <span>{hud.level}</span>
          </div>
          <div className="hud-bars">
            <div className="bar hp">
              <div className="fill" style={{ width: `${(100 * hud.hp) / hud.maxHp}%` }} />
              {hud.shieldMax > 0 && hud.shield > 0 && (
                <div className="fill shield" style={{ width: `${Math.min(100, (100 * hud.shield) / hud.maxHp)}%` }} />
              )}
              <span>
                {Math.ceil(hud.hp)} / {hud.maxHp}
                {hud.shieldMax > 0 && (
                  <em className="shield-num">
                    <svg className="ward-glyph" viewBox="0 0 24 26" aria-hidden="true">
                      <path d="M12 1.5 L21.5 5.2 V13 C21.5 19.6 17 23.6 12 24.8 C7 23.6 2.5 19.6 2.5 13 V5.2 Z" />
                    </svg>
                    {Math.ceil(hud.shield)}
                  </em>
                )}
              </span>
            </div>
          </div>
        </div>
        <div className="hud-center">
          <div className="clock">{fmtTime(hud.time)}</div>
          {hud.ahead > 0 && (
            <div className="clock-deep" title="The Dark Bargain — this dream began that deep">⇣ began {fmtTime(hud.ahead)} deep</div>
          )}
          <div className="kills">{hud.kills} banished</div>
        </div>
        <div className="hud-right">
          <div className="currency">✦ {hud.dust}</div>
          {hud.shards > 0 && <div className="currency shards">❖ {hud.shards}</div>}
        </div>
      </div>
      <div className="hud-spells">
        {hud.spells.map((s) => {
          const def = SPELLS[s.id];
          return (
            <div key={s.id} className="chip-wrap" style={{ '--c': def.color } as React.CSSProperties}>
              <div className={`spell-chip ${s.evolved ? 'evolved' : ''}`}>
                <span className="glyph"><SpellIcon id={s.id} size={22} /></span>
                <span className="lv">{s.evolved ? '★' : s.level}</span>
              </div>
              <ChipTip
                name={s.evolved ? EVOLVE[s.id].name : def.name}
                kind={s.evolved ? 'Evolved' : `Level ${s.level}`}
                desc={s.evolved ? EVOLVE[s.id].desc : def.desc}
              />
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, (hud.spellCap || 6) - hud.spells.length) }).map((_, i) => (
          <div key={`empty-${i}`} className="chip-wrap">
            <div className="spell-chip empty"><span className="glyph">+</span></div>
            <ChipTip name="Empty slot" desc="Waiting to be filled as new spells find you." />
          </div>
        ))}
        {boons.length > 0 && <div className="dock-divider" />}
        {boons.map(([id, lv]) => (
          <div key={id} className="chip-wrap">
            <div className="spell-chip boon">
              <span className="glyph">{BOONS[id].icon}</span>
              <span className="lv">{lv}</span>
            </div>
            <ChipTip name={BOONS[id].name} kind={`Rank ${lv}`} desc={BOONS[id].desc} />
          </div>
        ))}
        {hud.relics.length > 0 && <div className="dock-divider" />}
        {hud.relics.map((id) => (
          <div key={id} className="chip-wrap" style={{ '--c': RELICS[id].color } as React.CSSProperties}>
            <div className="spell-chip relic"><span className="glyph">{RELICS[id].icon}</span></div>
            <ChipTip name={RELICS[id].name} kind="Relic" desc={RELICS[id].desc} />
          </div>
        ))}
      </div>
      {firstDream && (
        <div className={`coach${coachGone ? ' gone' : ''}`}>
          Drift with WASD — your spells cast themselves
        </div>
      )}
    </>
  );
}

function PauseMenu({ onResume, onReturnToMenu, onSettings }: { onResume: () => void; onReturnToMenu: () => void; onSettings: () => void }) {
  return (
    <div className="overlay pause-overlay">
      <div className="pause-panel panel">
        <div className="eyebrow">the dream holds still</div>
        <h2>Paused</h2>
        <div className="orn" aria-hidden="true">✦</div>
        <div className="menu-buttons">
          <button className="btn-primary" onClick={onResume}>Return to the dream</button>
          <button className="btn-secondary" onClick={onSettings}>Tune the dream</button>
          <button className="btn-secondary" onClick={onReturnToMenu}>Abandon this dream</button>
        </div>
        <div className="controls-hint">Esc resumes · an abandoned dream yields no stardust</div>
      </div>
    </div>
  );
}

function Menu({ onStart, onTree, onDark, onBook, onSettings, meta, closing }: {
  onStart: () => void; onTree: () => void; onDark: () => void; onBook: () => void; onSettings: () => void; meta: Meta;
  closing?: boolean;
}) {
  const sky = useSkyState();
  const unseen = codex.unseen();
  return (
    <div className={`overlay menu${closing ? ' closing' : ''}`}>
      <div className="menu-bg" aria-hidden="true" style={sky} />
      <div className="title-block">
        <h1>Dreamtide</h1>
        <div className="menu-subtitle">Reverie of the Last Magus</div>
        <div className="menu-buttons">
          <button className="btn-primary" onClick={onStart}>Fall asleep</button>
          {/* the Constellation stays a secret until its discovery has played;
              after a first death it appears as an unexplained glimmer */}
          {meta.treeRevealed ? (
            <button className="btn-secondary" onClick={onTree}>
              The Constellation
              <span className="dust-chip">✦ {meta.dust}{meta.points > 0 ? ` · ◈ ${meta.points}` : ''}</span>
            </button>
          ) : (meta.best > 0 || meta.dust > 0) ? (
            <button className="btn-secondary glimmer" onClick={onTree}>✦ Something glimmers in the dark</button>
          ) : null}
          {/* the Dark Bargain surfaces once a nightmare shard has been carried
              out of a dream — first as an unexplained wound */}
          {meta.darkRevealed ? (
            <button className="btn-secondary dark-btn" onClick={onDark}>
              The Dark Bargain
              <span className="dust-chip shards">❖ {meta.shards}{meta.darkPoints > 0 ? ` · ◈ ${meta.darkPoints}` : ''}</span>
            </button>
          ) : (meta.shards || 0) > 0 ? (
            <button className="btn-secondary glimmer-dark" onClick={onDark}>❖ Something festers beneath the stars</button>
          ) : null}
          <button className="btn-secondary book-btn" onClick={onBook}>
            The Dream Book
            {unseen > 0 && <span className="book-badge" title={`${unseen} new discovery${unseen === 1 ? '' : 'ies'}`}>{unseen}</span>}
          </button>
          <button className="btn-secondary" onClick={onSettings}>Tune the dream</button>
          {isNative && (
            <button className="btn-secondary" onClick={exitApp}>Leave the dream</button>
          )}
        </div>
        <div className="menu-foot">
          {(meta.best || 0) > 0 && <div className="best-run">Deepest dream — {fmtTime(meta.best)}</div>}
          <div className="controls-hint">Drift with WASD or the arrow keys · your spells cast themselves</div>
        </div>
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
          style={{ '--val': `${Math.round(value * 100)}%` } as React.CSSProperties}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
        />
        <span className="vol-num">{Math.round(value * 100)}%</span>
      </div>
    </div>
  );
}

function Settings({ onClose, extraClass }: { onClose: () => void; extraClass?: string }) {
  const sky = useSkyState();
  // local mirror so the sliders/buttons re-render; the settings singleton is
  // the source of truth and persists each change.
  const [music, setMusic] = useState(settings.musicVol);
  const [sfx, setSfx] = useState(settings.sfxVol);
  const [perf, setPerf] = useState<PerfPresets>({ ...settings.perf });
  const [res, setRes] = useState<ResolutionScale>(settings.resolution);
  const [hdr, setHdr] = useState(settings.hdr);
  const [hdrOk, setHdrOk] = useState(hdrSupported());
  const [dev, setDev] = useState(settings.devEndgame);
  const [devFin, setDevFin] = useState(settings.devFinale);
  const [devTree, setDevTree] = useState(settings.devFreeTree);

  const changeMusic = (v: number) => { settings.setMusicVol(v); audio.setMusicVolume(v); setMusic(v); };
  const changeSfx = (v: number) => { settings.setSfxVol(v); audio.setSfxVolume(v); setSfx(v); };
  const changePerf = (k: keyof PerfPresets, p: Preset) => { settings.setPerf(k, p); setPerf({ ...settings.perf }); };
  const changeRes = (v: ResolutionScale) => { settings.setResolution(v); setRes(v); };
  const changeHdr = (v: boolean) => { settings.setHdr(v); setHdr(v); };

  // track live HDR capability: flips when the player toggles Windows HDR while
  // the settings panel is open.
  useEffect(() => watchHdrSupport(setHdrOk), []);
  const changeDev = (v: boolean) => { settings.setDevEndgame(v); setDev(v); };
  const changeDevFin = (v: boolean) => { settings.setDevFinale(v); setDevFin(v); };
  const changeDevTree = (v: boolean) => { settings.setDevFreeTree(v); setDevTree(v); };
  const resetDefaults = () => {
    settings.resetDefaults();
    audio.setMusicVolume(settings.musicVol);
    audio.setSfxVolume(settings.sfxVol);
    setMusic(settings.musicVol);
    setSfx(settings.sfxVol);
    setPerf({ ...settings.perf });
    setRes(settings.resolution);
    setHdr(settings.hdr);
    setDev(settings.devEndgame);
    setDevFin(settings.devFinale);
    setDevTree(settings.devFreeTree);
  };

  return (
    <div className={`overlay settings-overlay${extraClass ? ` ${extraClass}` : ''}`}>
      <div className="menu-bg" aria-hidden="true" style={sky} />
      <div className="settings-panel panel">
        <div className="settings-head">
          <div>
            <div className="eyebrow">the waking world</div>
            <h2 className="settings-title">Tune the dream</h2>
          </div>
          <div className="settings-head-actions">
            <button className="btn-secondary" onClick={resetDefaults}>Restore defaults</button>
            <button className="btn-secondary" onClick={onClose}>Return</button>
          </div>
        </div>

        <div className="settings-scroll">
          <section className="set-section">
            <h3 className="set-heading">Sound</h3>
            <VolumeRow label="Music" value={music} onChange={changeMusic} />
            <VolumeRow label="Sounds" value={sfx} onChange={changeSfx} />
          </section>

          <section className="set-section">
            <h3 className="set-heading">Performance</h3>
            <p className="set-note">The late tide is heavy with bodies — ease these if the dream stutters. Medium is the default.</p>
            <PresetRow label="Particles" hint="Density of the drifting dream-motes" value={perf.particles} onPick={(p) => changePerf('particles', p)} />
            <PresetRow label="Damage numbers" hint="How many numbers bloom from your strikes at once" value={perf.dmgText} onPick={(p) => changePerf('dmgText', p)} />
            <PresetRow label="Enemy health bars" hint="How many bars the horde may wear at once" value={perf.hpBars} onPick={(p) => changePerf('hpBars', p)} />
            <div className="set-row">
              <div className="set-label">
                <span className="set-name">Resolution</span>
                <span className="set-hint">Sharpness of the dream itself — lower renders lighter</span>
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
            <div className="set-row" style={hdrOk ? undefined : { opacity: 0.5 }}>
              <div className="set-label">
                <span className="set-name">HDR</span>
                <span className="set-hint">
                  {hdrOk
                    ? 'Let bright spells bloom past white into your display’s headroom'
                    : 'No HDR display detected — turn on “Use HDR” in Windows display settings'}
                </span>
              </div>
              <div className="preset-group">
                <button className={`preset-btn ${!hdr ? 'active' : ''}`} onClick={() => changeHdr(false)}>Off</button>
                <button className={`preset-btn ${hdr ? 'active' : ''}`} disabled={!hdrOk} onClick={() => changeHdr(true)}>On</button>
              </div>
            </div>
          </section>

          <section className="set-section dev-section">
            <h3 className="set-heading">Dev only</h3>
            <label className="dev-toggle">
              <input type="checkbox" checked={dev} onChange={(e) => changeDev(e.target.checked)} />
              ⚗ endgame test — start at 6:00 with a full random loadout (lv 5 / evolved)
            </label>
            <label className="dev-toggle">
              <input type="checkbox" checked={devFin} onChange={(e) => changeDevFin(e.target.checked)} />
              ⚗ finale test — start at 14:50, moments before the other dreamer arrives
            </label>
            <label className="dev-toggle">
              <input type="checkbox" checked={devTree} onChange={(e) => changeDevTree(e.target.checked)} />
              ⚗ endless stardust — constellation nodes cost nothing to awaken
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dream book
// The dreamer's journal. Fundamentals are always legible; everything else stays
// sealed until the player meets it in a dream (see codex.ts). Every section
// enumerates the live content tables, so new spells / relics / pacts appear as
// locked entries the moment they exist — nothing here is a hand-kept list.

type BookTab = 'basics' | 'spells' | 'boons' | 'relics' | 'pacts' | 'reactions';

// The craft of dreaming — the rules beneath every run. Always unsealed.
const FUNDAMENTALS: { icon: string; title: string; body: string }[] = [
  { icon: '➳', title: 'Drifting', body: 'Move with WASD or the arrow keys. Your spells aim and cast themselves — your only job is where you stand.' },
  { icon: '≋', title: 'Casting', body: 'Each spell fires on its own cooldown, usually at the nearest foe. Some instead circle you as wards, orbits or auras.' },
  { icon: '✦', title: 'Spell damage', body: 'Leveling a spell raises its damage. All your damage bonuses — boons, stars, surges, pacts — multiply together.' },
  { icon: '✷', title: 'Critical strikes', body: 'Some stars give a chance to strike for 150% damage. Crit-damage bonuses raise that even higher.' },
  { icon: '↻', title: 'Spell Haste', body: 'Haste shortens every cooldown, so you cast more often. Boons, stars and surges all add to it.' },
  { icon: '◎', title: 'Area of effect', body: 'Area bonuses grow the area a spell covers — +300% area is double the radius. A spell’s own stars grow its radius directly, a bigger jump.' },
  { icon: '❈', title: 'Essence & Reverie', body: 'Foes drop essence. Gather it to level up and choose a new spell, an upgrade, or a boon. Dream Lure widens your pickup area.' },
  { icon: '★', title: 'Mastery', body: 'Past its max level, a spell keeps gaining +8% damage per pick — forever. A maxed spell is never a wasted choice.' },
  { icon: '❂', title: 'Evolution', body: 'Max a spell whose evolution you’ve unlocked in the Constellation, and its final form is offered — a whole new behaviour.' },
  { icon: '≈', title: 'Surges', body: 'Short bursts of power — swiftness, damage, haste, area or pickup — that trigger every few seconds.' },
  { icon: '❆', title: 'Resonance', body: 'Elements leave marks: cold chills, storm charges, light brands. Hit a marked foe with the right element to set off a reaction.' },
];

function BookGlyph({ icon, id, size = 30 }: { icon: string; id?: string; size?: number }) {
  return <span className="be-glyph">{id && HAS_ICON(id) ? <SpellIcon id={id} size={size} /> : icon}</span>;
}

// A sealed entry — shape and count preserved so the player feels the shape of
// what they have yet to find, without spoiling it.
function LockedEntry({ hint }: { hint: string }) {
  return (
    <div className="book-entry locked" aria-label="undiscovered">
      <div className="be-head">
        <span className="be-glyph">?</span>
        <div className="be-title"><div className="be-name">Undreamed</div><div className="be-tag">sealed</div></div>
      </div>
      <div className="be-desc">{hint}</div>
    </div>
  );
}

function SpellEntry({ id }: { id: string }) {
  const def = SPELLS[id];
  const lvl = codex.spellLevel(id);
  const evolved = codex.knowsEvolution(id);
  // levelText(l) describes the step taken TO level l; level 1 is the base desc
  const steps: number[] = [];
  for (let l = 2; l <= Math.min(lvl, def.maxLevel); l++) steps.push(l);
  return (
    <div className="book-entry spell" style={{ '--c': def.color } as React.CSSProperties}>
      <div className="be-head">
        <BookGlyph icon={def.icon} id={id} />
        <div className="be-title">
          <div className="be-name">{def.name}</div>
          <div className="be-tag">{def.school}<em> · seen to lv {Math.min(lvl, def.maxLevel)}</em></div>
        </div>
      </div>
      <div className="be-desc">{def.desc}</div>
      {steps.length > 0 && (
        <div className="be-levels">
          {steps.map((l) => (
            <div className="be-level" key={l}>
              <span className="be-lv">{l}</span>
              <span className="be-lv-text">{def.levelText(l)}</span>
            </div>
          ))}
        </div>
      )}
      {evolved && (
        <div className="be-evo">
          <span className="be-evo-name">❂ {EVOLVE[id].name}</span>
          <span className="be-evo-text">{EVOLVE[id].desc}</span>
        </div>
      )}
    </div>
  );
}

function DreamBook({ onClose }: { onClose: () => void }) {
  const sky = useSkyState();
  const [tab, setTab] = useState<BookTab>('basics');
  // opening the book clears the "new" glow on the menu button
  useEffect(() => { codex.markSeen(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const spellIds = Object.keys(SPELLS);
  const boonIds = Object.keys(BOONS);
  const genericIds = Object.keys(GENERIC);
  const relicIds = Object.keys(RELICS);
  const reactionIds = Object.keys(REACTIONS);

  const count = (ids: string[], known: (id: string) => boolean) => ids.filter(known).length;
  const tabs: { id: BookTab; label: string; found: number; total: number }[] = [
    { id: 'basics', label: 'The Craft', found: FUNDAMENTALS.length, total: FUNDAMENTALS.length },
    { id: 'spells', label: 'Spells', found: count(spellIds, codex.knowsSpell.bind(codex)), total: spellIds.length },
    { id: 'boons', label: 'Boons', found: count(boonIds, codex.knowsBoon.bind(codex)) + count(genericIds, codex.knowsGeneric.bind(codex)), total: boonIds.length + genericIds.length },
    { id: 'relics', label: 'Relics', found: count(relicIds, codex.knowsRelic.bind(codex)), total: relicIds.length },
    { id: 'pacts', label: 'Pacts', found: count(PACTS.map((p) => p.id), codex.knowsPact.bind(codex)), total: PACTS.length },
    { id: 'reactions', label: 'Interactions', found: count(reactionIds, codex.knowsReaction.bind(codex)), total: reactionIds.length },
  ];

  return (
    <div className="overlay settings-overlay book-overlay">
      <div className="menu-bg" aria-hidden="true" style={sky} />
      <div className="settings-panel book-panel panel">
        <div className="settings-head">
          <div>
            <div className="eyebrow">the dreamer’s journal</div>
            <h2 className="settings-title">The Dream Book</h2>
          </div>
          <div className="settings-head-actions">
            <button className="btn-secondary" onClick={onClose}>Return</button>
          </div>
        </div>

        <div className="book-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`book-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className="bt-label">{t.label}</span>
              {t.id !== 'basics' && <span className="bt-count">{t.found}/{t.total}</span>}
            </button>
          ))}
        </div>

        <div className="settings-scroll book-scroll">
          {tab === 'basics' && (
            <div className="book-lore-list">
              {FUNDAMENTALS.map((f) => (
                <div className="book-lore" key={f.title}>
                  <span className="bl-glyph">{f.icon}</span>
                  <div className="bl-body">
                    <div className="bl-title">{f.title}</div>
                    <div className="bl-text">{f.body}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'spells' && (
            <div className="book-grid">
              {spellIds.map((id) => codex.knowsSpell(id)
                ? <SpellEntry key={id} id={id} />
                : <LockedEntry key={id} hint="A spell you have yet to weave into a dream." />)}
            </div>
          )}

          {tab === 'boons' && (
            <>
              <h3 className="set-heading">Boons</h3>
              <div className="book-grid">
                {boonIds.map((id) => {
                  const b = BOONS[id];
                  if (!codex.knowsBoon(id)) return <LockedEntry key={id} hint="A blessing you have yet to accept." />;
                  return (
                    <div className="book-entry boon" key={id}>
                      <div className="be-head">
                        <BookGlyph icon={b.icon} />
                        <div className="be-title"><div className="be-name">{b.name}</div><div className="be-tag">up to rank {b.max}</div></div>
                      </div>
                      <div className="be-desc">{b.desc}</div>
                    </div>
                  );
                })}
              </div>
              <h3 className="set-heading">Amplifications</h3>
              <div className="book-grid">
                {genericIds.map((id) => {
                  const g = GENERIC[id];
                  if (!codex.knowsGeneric(id)) return <LockedEntry key={id} hint="An amplification you have yet to take." />;
                  return (
                    <div className="book-entry boon" key={id}>
                      <div className="be-head">
                        <BookGlyph icon={g.icon} />
                        <div className="be-title"><div className="be-name">{g.name}</div><div className="be-tag">endless</div></div>
                      </div>
                      <div className="be-desc">{g.desc}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === 'relics' && (
            <div className="book-grid">
              {relicIds.map((id) => {
                const r = RELICS[id];
                if (!codex.knowsRelic(id)) return <LockedEntry key={id} hint="A relic no fallen nightmare has yet offered you." />;
                return (
                  <div className="book-entry relic" key={id} style={{ '--c': r.color } as React.CSSProperties}>
                    <div className="be-head">
                      <BookGlyph icon={r.icon} />
                      <div className="be-title"><div className="be-name">{r.name}</div><div className="be-tag">relic</div></div>
                    </div>
                    <div className="be-desc">{r.desc}</div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'pacts' && (
            <div className="book-grid">
              {PACTS.map((p) => {
                if (!codex.knowsPact(p.id)) return <LockedEntry key={p.id} hint="A bargain no altar has yet whispered to you." />;
                return (
                  <div className="book-entry pact" key={p.id}>
                    <div className="be-head">
                      <BookGlyph icon={p.icon} />
                      <div className="be-title"><div className="be-name">{p.name}</div><div className="be-tag">altar pact</div></div>
                    </div>
                    <div className="be-desc"><span className="pact-gift">{p.boon}</span> <span className="pact-cost">…but {p.curse}.</span></div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'reactions' && (
            <div className="book-grid">
              {reactionIds.map((id) => {
                const rx = REACTIONS[id];
                if (!codex.knowsReaction(id)) return <LockedEntry key={id} hint="A resonance you have yet to spark between two elements." />;
                return (
                  <div className="book-entry reaction" key={id} style={{ '--c': rx.color } as React.CSSProperties}>
                    <div className="be-head">
                      <BookGlyph icon={rx.icon} />
                      <div className="be-title"><div className="be-name">{rx.name}</div><div className="be-tag">{rx.recipe}</div></div>
                    </div>
                    <div className="be-desc">{rx.desc}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LevelUp({ choices, level, banishes, rerolls, showBanish, showReroll, masteryPer, onPick, onBanish, onReroll }: {
  choices: Choice[]; level: number; banishes: number; rerolls: number;
  showBanish: boolean; showReroll: boolean; masteryPer: number;
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

  // number keys pick a card without reaching for the mouse
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = e.key.charCodeAt(0) - 49; // '1' → 0
      if (i >= 0 && i < choices.length && !e.repeat) pick(choices[i]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="overlay levelup">
      <div className="eyebrow">the reverie deepens</div>
      <h2>Reverie {level}</h2>
      <div className="orn" aria-hidden="true">✦</div>
      <div className={`cards ${rolling ? 'rolling' : ''}`} key={deal}>
        {choices.map((c, i) => {
          const isEvolve = c.kind === 'evolve';
          const isSpell = c.kind === 'spell' || isEvolve;
          const def = isSpell ? SPELLS[c.id] : c.kind === 'boon' ? BOONS[c.id] : GENERIC[c.id];
          const spellDef = isSpell ? SPELLS[c.id] : null;
          const rank = isEvolve ? 'Evolution'
            : isSpell ? (c.isNew ? 'New spell' : c.mastery ? `Mastery ${c.level}` : `Level ${c.level}`)
            : `Rank ${c.level}`;
          const school = isEvolve || isSpell ? spellDef!.school : c.kind === 'generic' ? 'Amplify' : 'Boon';
          return (
            <div key={`${c.kind}-${c.id}-${i}`} className={`card-slot ${banishing === i ? 'banishing' : ''}`}>
              <button
                className={`card ${isEvolve ? 'evolve' : isSpell ? 'spell' : 'boon'}`}
                style={(isSpell && spellDef ? { '--c': spellDef.color, '--c2': spellDef.color2 } : { '--c': '#ffd27a', '--c2': '#fff2cc' }) as React.CSSProperties}
                onClick={() => pick(c)}
              >
                <span className="card-key" aria-hidden="true"><i>{i + 1}</i></span>
                <div className="card-rank">{rank}</div>
                <div className="card-glyph">{isSpell && HAS_ICON(c.id) ? <SpellIcon id={c.id} size={40} /> : def.icon}</div>
                <div className="card-name">{isEvolve ? EVOLVE[c.id].name : def.name}</div>
                <div className="card-school">{school}</div>
                <div className="card-line" aria-hidden="true" />
                <div className="card-desc">
                  {isEvolve
                    ? EVOLVE[c.id].desc
                    : c.kind === 'generic'
                      ? def.desc
                      : isSpell
                        ? (c.isNew
                            ? spellDef!.desc
                            : c.mastery
                              ? `Past max level — this rank adds +${masteryPer}% ${spellDef!.kind === 'defense' ? 'strength' : 'damage'} (${masteryPer * c.level!}% total).`
                              : spellDef!.levelText(c.level!))
                        : BOONS[c.id].per
                          ? `${BOONS[c.id].desc.replace(/\.$/, '')} (${BOONS[c.id].per! * c.level!}% total)`
                          : def.desc}
                </div>
              </button>
              {showBanish && (
                <button
                  className="banish-btn"
                  disabled={banishes <= 0 || banishing != null}
                  title="Banish this offer — it will not return this dream"
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
              title="Scatter these choices and dream up new ones"
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

// A fallen boss offers its relic: one of three, each a run-defining law of
// the dream. Same card language as level-ups, dressed in gold.
function RelicChoice({ choices, onPick }: { choices: string[]; onPick: (id: string) => void }) {
  const picked = useRef(false);
  const pick = (id: string) => {
    if (picked.current) return;
    picked.current = true;
    onPick(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const i = e.key.charCodeAt(0) - 49; // '1' → 0
      if (i >= 0 && i < choices.length && !e.repeat) pick(choices[i]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="overlay levelup relic-overlay">
      <div className="eyebrow">the nightmare leaves a gift</div>
      <h2>Claim a relic</h2>
      <div className="orn" aria-hidden="true">✦</div>
      <div className="cards">
        {choices.map((id, i) => {
          const r = RELICS[id];
          return (
            <div key={id} className="card-slot">
              <button
                className="card relic"
                style={{ '--c': r.color, '--c2': '#fff2cc' } as React.CSSProperties}
                onClick={() => pick(id)}
              >
                <span className="card-key" aria-hidden="true"><i>{i + 1}</i></span>
                <div className="card-rank">Relic</div>
                <div className="card-glyph">{r.icon}</div>
                <div className="card-name">{r.name}</div>
                <div className="card-school">Kept for the rest of this dream</div>
                <div className="card-line" aria-hidden="true" />
                <div className="card-desc">{r.desc}</div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A Whispering Altar's bargain: seal the pact (boon braided to a curse) or
// refuse it for a small mercy. Both answers are real choices.
function PactChoice({ pact, onAnswer }: { pact: PactDef; onAnswer: (accept: boolean) => void }) {
  const picked = useRef(false);
  const answer = (accept: boolean) => {
    if (picked.current) return;
    picked.current = true;
    onAnswer(accept);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === '1') answer(true);
      if (e.key === '2') answer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="overlay levelup pact-overlay">
      <div className="eyebrow">the altar whispers</div>
      <h2>{pact.name}</h2>
      <div className="orn" aria-hidden="true">❖</div>
      <div className="cards pact-cards">
        <div className="card-slot">
          <button
            className="card pact"
            style={{ '--c': '#c48cff', '--c2': '#ff5a7a' } as React.CSSProperties}
            onClick={() => answer(true)}
          >
            <span className="card-key" aria-hidden="true"><i>1</i></span>
            <div className="card-rank">Seal the pact</div>
            <div className="card-glyph">{pact.icon}</div>
            <div className="card-name">{pact.boon}</div>
            <div className="card-school">for the rest of this dream</div>
            <div className="card-line" aria-hidden="true" />
            <div className="card-desc pact-curse">…but {pact.curse}.</div>
          </button>
        </div>
        <div className="card-slot">
          <button
            className="card boon"
            style={{ '--c': '#7dffb0', '--c2': '#e8fbff' } as React.CSSProperties}
            onClick={() => answer(false)}
          >
            <span className="card-key" aria-hidden="true"><i>2</i></span>
            <div className="card-rank">Refuse</div>
            <div className="card-glyph">☽</div>
            <div className="card-name">A quiet blessing</div>
            <div className="card-school">the cautious road</div>
            <div className="card-line" aria-hidden="true" />
            <div className="card-desc">Restore a fifth of your life and gather a little essence. The altar sleeps again.</div>
          </button>
        </div>
      </div>
    </div>
  );
}

// The wake-rite: raised when the Other Dreamer falls. A held, luminous moment
// (the run continues, endless, once the dreamer chooses to dream on).
function Victory({ victory, onDreamOn }: { victory: VictoryInfo; onDreamOn: () => void }) {
  return (
    <div className="overlay won">
      <div className="won-rays" aria-hidden="true" />
      <div className="eyebrow">the other dreamer falls</div>
      <h2 className="won-title">The Dream Is Yours Again</h2>
      <div className="orn" aria-hidden="true">✦</div>
      <div className="result-row">
        <div className="stat"><span className="num">{fmtTime(victory.time)}</span><span className="lbl">the hour you woke</span></div>
        <div className="stat"><span className="num">{victory.kills}</span><span className="lbl">banished</span></div>
        <div className="stat"><span className="num">{victory.level}</span><span className="lbl">reverie</span></div>
      </div>
      {victory.firstClear ? (
        <div className="won-unlock">
          <div className="won-unlock-eyebrow">two vestments awaken</div>
          <div className="won-vestments">
            {CLEAR_SKINS.map((id) => (
              <div key={id} className="won-vestment">
                <span className="won-portrait" style={{ '--c': skinColor(id) } as React.CSSProperties}>
                  <WizardPortrait skin={WIZARD_SKINS[id]} size={58} />
                </span>
                <div className="won-unlock-name" style={{ '--c': skinColor(id) } as React.CSSProperties}>{skinName(id)}</div>
              </div>
            ))}
          </div>
          <div className="won-unlock-hint">worn by one who woke — don them in the Constellation</div>
        </div>
      ) : victory.clearBest > 0 ? (
        <div className="record-tag">✦ dreams woken ×{victory.cleared} · swiftest {fmtTime(victory.clearBest)} ✦</div>
      ) : null}
      {victory.relics.length > 0 && (
        <div className="go-relics" title="Relics carried when the dream broke">
          {victory.relics.map((id) => (
            <span key={id} className="go-relic" style={{ '--c': RELICS[id].color } as React.CSSProperties} title={RELICS[id].name}>
              {RELICS[id].icon}
            </span>
          ))}
        </div>
      )}
      <p className="won-coda">The tide is stilled — but the dream runs deeper still.</p>
      <div className="menu-buttons">
        <button className="btn-primary" onClick={onDreamOn}>Dream on</button>
      </div>
    </div>
  );
}

function GameOver({ result, dustEarned, meta, onRetry, onTree, onDark, onBook, onMenu }: {
  result: RunResult; dustEarned: number; meta: Meta;
  onRetry: () => void; onTree: () => void; onDark: () => void; onBook: () => void; onMenu: () => void;
}) {
  // discoveries made this dream light up the Dream Book button
  const unseen = codex.unseen();
  return (
    <div className="overlay dead">
      <div className="eyebrow">the dream closes over you</div>
      <h2>You wake</h2>
      {result.cleared && <div className="record-tag cleared-tag">✦ the dream was yours — the Other Dreamer fell ✦</div>}
      {result.record && <div className="record-tag">✦ your deepest dream yet ✦</div>}
      <div className="orn" aria-hidden="true">✦</div>
      <div className="result-row">
        <div className="stat"><span className="num">{fmtTime(result.time)}</span><span className="lbl">endured</span></div>
        <div className="stat"><span className="num">{result.kills}</span><span className="lbl">banished</span></div>
        <div className="stat"><span className="num">{result.level}</span><span className="lbl">reverie</span></div>
        <div className="stat"><span className="num dust">+{dustEarned}</span><span className="lbl">stardust</span></div>
        {(result.shards || 0) > 0 && <div className="stat"><span className="num shards">+{result.shards}</span><span className="lbl">shards</span></div>}
      </div>
      {result.relics.length > 0 && (
        <div className="go-relics" title="Relics claimed this dream">
          {result.relics.map((id) => (
            <span key={id} className="go-relic" style={{ '--c': RELICS[id].color } as React.CSSProperties} title={RELICS[id].name}>
              {RELICS[id].icon}
            </span>
          ))}
        </div>
      )}
      <div className="menu-buttons">
        <button className="btn-primary" onClick={onRetry}>Sleep again</button>
        {meta.treeRevealed ? (
          <button className="btn-secondary" onClick={onTree}>The Constellation</button>
        ) : (
          <button className="btn-secondary glimmer" onClick={onTree}>✦ Something glimmers in the dark</button>
        )}
        {meta.darkRevealed ? (
          <button className="btn-secondary dark-btn" onClick={onDark}>The Dark Bargain</button>
        ) : (meta.shards || 0) > 0 ? (
          <button className="btn-secondary glimmer-dark" onClick={onDark}>❖ Something festers beneath the stars</button>
        ) : null}
        <button className="btn-secondary book-btn" onClick={onBook}>
          The Dream Book
          {unseen > 0 && <span className="book-badge" title={`${unseen} new discovery${unseen === 1 ? '' : 'ies'}`}>{unseen}</span>}
        </button>
        <button className="btn-secondary" onClick={onMenu}>Return to the menu</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- skill webs
// Both webs draw through the canvas renderer (see treeCanvas.tsx); these
// components own the screen chrome: header, the point forge, tooltip,
// loadout bar and the first-discovery captions.

const EMPTY_SET = new Set<string>();

// frontier: every unowned star adjacent to a lit one
function frontierOf(owned: string[], dark: boolean): Set<string> {
  const ownedSet = new Set(owned);
  const out = new Set<string>();
  for (const id of owned) {
    for (const nb of ADJACENT[id] || []) {
      if (ownedSet.has(nb)) continue;
      const n = NODE_MAP[nb];
      if (n && !!n.dark === dark) out.add(nb);
    }
  }
  return out;
}

// current UI zoom (see --ui-scale in styles.css). Fixed-position elements inside
// a zoomed layer have their px coordinates multiplied by it, so JS-placed
// positions must be divided back.
const uiScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;

interface TipState { id: string; x: number; y: number }

// A small footnote explaining a complex mechanic, shown on every node that uses
// it (derived from the node's fx, so new nodes get it automatically).
function noteFor(fx: Record<string, any> | undefined): { label: string; text: string } | null {
  if (!fx) return null;
  if (fx.evo) return { label: 'Evolution', text: 'Offered as a level-up once this spell reaches its max level in a dream.' };
  if (fx.masteryPlus) return { label: 'Mastery', text: 'The bonus level-ups a spell earns past its max level; each rank adds another slice of its base damage.' };
  if (Object.keys(fx).some((k) => k.startsWith('surge'))) return { label: 'Surge', text: 'Every 8s, each surge you own rolls its chance to fire for 4s — swiftness +35% move speed, power +30% damage, haste +30% spell haste, area +30% area, pickup +60% pickup area.' };
  if (fx.spellSlots) return { label: 'Spell slots', text: 'How many spells you carry into each dream. Choose them in the loadout bar below the tree.' };
  if (fx.banish) return { label: 'Banish', text: 'At a level-up, remove one offered card; that upgrade will not be offered again for the rest of the dream.' };
  if (fx.reroll) return { label: 'Reroll', text: 'At a level-up, replace all the offered cards with a fresh set.' };
  if (fx.golden) return { label: 'Golden wisp', text: 'A rare, fleeing spark. Catch it before it escapes for a burst of stardust and essence.' };
  if (fx.crit || fx.critDmg) return { label: 'Critical strike', text: 'Each hit has a chance to deal 150% damage; critical-damage bonuses add on top of that 150%.' };
  if (fx.xp || fx.extraGem) return { label: 'Essence', text: 'The motes fallen foes drop; gathering them fills your Reverie bar to reach the next level.' };
  return null;
}

function NodeTip({ tip, meta, dark, frontier, removable }: {
  tip: TipState; meta: Meta; dark: boolean;
  frontier: Set<string>; removable: Set<string>;
}) {
  const node = NODE_MAP[tip.id];
  if (!node) return null;
  const note = noteFor(node.fx);
  const ownedList = dark ? meta.darkOwned : meta.owned;
  const isOwned = ownedList.includes(node.id);
  const isCore = node.kind === 'core';
  const points = dark ? meta.darkPoints : meta.points;
  const cur = dark ? '❖' : '✦';
  const mintCost = dark ? nextDarkPointCost(meta) : nextPointCost(meta);
  const canMint = dark ? canBuyDarkPoint(meta) : canBuyPoint(meta);
  return (
    <div className={`node-tip${dark ? ' dark' : ''}`} style={{ left: tip.x / uiScale(), top: tip.y / uiScale() }}>
      <div className="tip-name">
        {node.name}
        <span className={`tip-kind ${node.kind}`}>{isCore ? 'origin' : node.kind}</span>
      </div>
      <div className="tip-desc">{node.desc}</div>
      {note && <div className="tip-note"><b>{note.label}</b> — {note.text}</div>}
      {isCore ? (
        <div className="tip-row">
          <span className={`tip-cost ${dark ? 'shards' : ''}`}>{cur} {mintCost}</span>
          {settings.devFreeTree ? (
            <span className="tip-hint">the dream is unlocked</span>
          ) : canMint ? (
            <span className="tip-hint">click to forge a skill point</span>
          ) : (
            <span className="tip-locked">{dark ? 'not enough shards — nightmares guard them' : 'not enough stardust — wake with more'}</span>
          )}
        </div>
      ) : isOwned ? (
        <div className="tip-owned">
          ✓ awakened
          {removable.has(node.id)
            ? <span className="tip-refund"> · click to release — its point returns to you</span>
            : <span className="tip-locked"> · other stars depend on this one</span>}
        </div>
      ) : (
        <div className="tip-row">
          <span className={`tip-cost ${dark ? 'shards' : ''}`}>◈ 1 point</span>
          {!frontier.has(node.id) ? (
            <span className="tip-locked">no lit path reaches this star yet</span>
          ) : points > 0 || settings.devFreeTree ? (
            <span className="tip-hint">click to awaken</span>
          ) : (
            <span className="tip-locked">{dark ? 'no points — feed the Wound a shard' : 'no points — forge one at the Waking Eye'}</span>
          )}
        </div>
      )}
    </div>
  );
}

function SkillTree({ meta, reveal, onRevealed, onMeta, onLoadout, onSkin, onClose }: {
  meta: Meta; reveal: boolean;
  onRevealed: () => void; onMeta: (m: Meta) => void;
  onLoadout: (loadout: string[]) => void; onSkin: (id: string) => void; onClose: () => void;
}) {
  const sky = useSkyState();
  const [phase, setPhase] = useState<TreePhase>(reveal ? 'seed' : 'done');
  const [tip, setTip] = useState<TipState | null>(null);
  const [pulse, setPulse] = useState<{ id: string; key: number } | null>(null);
  const [query, setQuery] = useState('');
  const pulseKey = useRef(0);

  const owned = useMemo(() => new Set(meta.owned), [meta.owned]);
  const frontier = useMemo(() => frontierOf(meta.owned, false), [meta.owned]);
  const removable = useMemo(() => removableSet(meta.owned, 'core'), [meta.owned]);
  const allocatable = meta.points > 0 || settings.devFreeTree ? frontier : EMPTY_SET;

  // stat search: every term must appear in a star's name or effect text, so
  // "move" lights every movement-speed star, "crit dmg" narrows to crit damage
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const terms = q.split(/\s+/);
    const out = new Set<string>();
    for (const n of CONST_NODES) {
      if (n.kind === 'core') continue;
      const hay = `${n.name} ${n.desc}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) out.add(n.id);
    }
    return out;
  }, [query]);

  const firePulse = (id: string) => { pulseKey.current += 1; setPulse({ id, key: pulseKey.current }); };

  const clickNode = (id: string) => {
    const m = useGame.getState().meta;
    if (phase === 'seed') {
      // during the discovery, the lone star is the only door — and this first
      // touch of the Waking Eye also forges the free opening point, so the
      // player doesn't have to click it a second time to claim it
      if (id === 'core') {
        if (canBuyPoint(m)) onMeta(buyPoint(m));
        setPhase('expanding'); setTip(null); audio.levelUp();
      }
      return;
    }
    if (phase !== 'done') return;
    if (id === 'core') {
      if (canBuyPoint(m)) { onMeta(buyPoint(m)); firePulse('core'); audio.choose(); }
      return;
    }
    if (m.owned.includes(id)) {
      const next = deallocateNode(m, id);
      if (next !== m) { onMeta(next); audio.banish(); }
    } else {
      const next = allocateNode(m, id);
      if (next !== m) { onMeta(next); firePulse(id); audio.choose(); }
    }
  };

  const hoverNode = (id: string | null, x: number, y: number) => {
    // no tooltips during the discovery — "origin" on the lone star would give
    // the whole mystery away before it's touched
    if (phase !== 'done') return;
    setTip(id ? { id, x, y } : null);
  };

  // the Constellation's sky gains one more wonder — a nebula, a comet, an
  // aurora, a ring… — for each equal slice of skill points forged. The full
  // tree's points split into 8 breakpoints, one per flair.
  const CONST_FLAIRS = 8;
  const keys = Math.min(CONST_FLAIRS, Math.floor(meta.pointsBought / ((CONST_NODES.length - 1) / CONST_FLAIRS)));
  return (
    <div className={`overlay tree-overlay${phase === 'seed' ? ' reveal-seed' : ''}`}>
      <div className="tree-bg" aria-hidden="true" style={sky} />
      {Array.from({ length: keys }, (_, i) => (
        <div key={i} className={`tree-flair cf${i + 1}`} aria-hidden="true" style={sky} />
      ))}
      <div className={`tree-head${phase !== 'done' ? ' veiled' : ''}`}>
        <div>
          <div className="tree-title">The Constellation</div>
          <div className="tree-sub">Every star costs one skill point; a star only wakes beside a lit one. Release a star to take its point back.</div>
        </div>
        <div className="tree-search-wrap">
          <input
            className="tree-search"
            type="search"
            placeholder="Search stars… (move, crit, aoe)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            title="Every star whose name or effect mentions this lights up in blue"
          />
          {matches && <span className="tree-search-count">{matches.size}</span>}
        </div>
        <div className="tree-progress" title="Stars awakened">{meta.owned.length - 1} / {CONST_NODES.length - 1} stars</div>
        <div className="point-chip" title="Unspent skill points — spend them on any star touching your lit web">◈ {settings.devFreeTree ? '∞' : meta.points}</div>
        <div className="dust-big" title="Stardust — earned each time you wake">✦ {settings.devFreeTree ? '∞' : meta.dust}</div>
        <button
          className={`btn-secondary forge-btn${phase === 'done' && canBuyPoint(meta) ? ' hot' : ''}`}
          disabled={!canBuyPoint(meta)}
          onClick={() => clickNode('core')}
          title="Forge a skill point from stardust — each costs more than the last"
        >
          {nextPointCost(meta) === 0 ? 'Forge a point — free' : `Forge a point — ✦ ${nextPointCost(meta)}`}
        </button>
        {settings.devFreeTree && (
          <>
            <button
              className="btn-secondary"
              onClick={() => { const next = allocateAllLight(useGame.getState().meta); if (next !== meta) { onMeta(next); audio.levelUp(); } }}
              title="Dev: awaken every star at once"
            >
              ⚗ Allocate all
            </button>
            <button
              className="btn-secondary"
              onClick={() => { const next = resetAllLight(useGame.getState().meta); if (next !== meta) { onMeta(next); audio.banish(); } }}
              title="Dev: release every star back to the core"
            >
              ⚗ Reset all
            </button>
          </>
        )}
        <button className="btn-secondary" onClick={onClose}>Return</button>
      </div>

      <div className="tree-wrap">
        <TreeCanvas
          nodes={CONST_NODES} edges={CONST_EDGES} nodeMap={NODE_MAP}
          owned={owned} allocatable={allocatable} removable={removable} reachable={frontier}
          phase={phase} coreHot={phase === 'done' && canBuyPoint(meta)}
          highlight={matches}
          variant="arcane" fitRadius={1055}
          pulse={pulse}
          onNodeClick={clickNode}
          onHoverNode={hoverNode}
          onRevealDone={() => { setPhase('done'); audio.bonus(); onRevealed(); }}
        />
        {tip && phase === 'done' && <NodeTip tip={tip} meta={meta} dark={false} frontier={frontier} removable={removable} />}
      </div>

      {phase === 'seed' && (
        <div className="reveal-caption">
          <div className="rc-line">a lone star waits in the dark</div>
          <div className="rc-hint">touch it</div>
        </div>
      )}

      <LoadoutBar meta={meta} onLoadout={onLoadout} onSkin={onSkin} veiled={phase !== 'done'} />
    </div>
  );
}

// The Dark Bargain: a corrupted sigil fed with nightmare shards. Its stars
// start every dream deeper — harder from the first breath, but the clock (and
// your best time) begins deeper too.
function DarkBargain({ meta, reveal, onRevealed, onMeta, onClose }: {
  meta: Meta; reveal: boolean;
  onRevealed: () => void; onMeta: (m: Meta) => void; onClose: () => void;
}) {
  const sky = useSkyState();
  const [phase, setPhase] = useState<TreePhase>(reveal ? 'seed' : 'done');
  const [tip, setTip] = useState<TipState | null>(null);
  const [pulse, setPulse] = useState<{ id: string; key: number } | null>(null);
  const pulseKey = useRef(0);

  const owned = useMemo(() => new Set(meta.darkOwned), [meta.darkOwned]);
  const frontier = useMemo(() => frontierOf(meta.darkOwned, true), [meta.darkOwned]);
  const removable = useMemo(() => removableSet(meta.darkOwned, 'dark-core'), [meta.darkOwned]);
  const allocatable = meta.darkPoints > 0 || settings.devFreeTree ? frontier : EMPTY_SET;
  const depth = darkDepth(meta);

  const firePulse = (id: string) => { pulseKey.current += 1; setPulse({ id, key: pulseKey.current }); };

  const clickNode = (id: string) => {
    const m = useGame.getState().meta;
    if (phase === 'seed') {
      if (id === 'dark-core') {
        // the first touch: the Wound drinks a shard and yields the first drop —
        // and the corrupted swell wells up right on the click, riding the reveal
        if (canBuyDarkPoint(m)) onMeta(buyDarkPoint(m));
        setPhase('expanding');
        setTip(null);
        audio.darkReveal();
      }
      return;
    }
    if (phase !== 'done') return;
    if (id === 'dark-core') {
      if (canBuyDarkPoint(m)) { onMeta(buyDarkPoint(m)); firePulse('dark-core'); audio.choose(); }
      return;
    }
    if (m.darkOwned.includes(id)) {
      const next = deallocateNode(m, id);
      if (next !== m) { onMeta(next); audio.banish(); }
    } else {
      const next = allocateNode(m, id);
      if (next !== m) { onMeta(next); firePulse(id); audio.choose(); }
    }
  };

  const hoverNode = (id: string | null, x: number, y: number) => {
    if (phase !== 'done') return;
    setTip(id ? { id, x, y } : null);
  };

  // the Wound's sky corrupts a little further for each equal slice of bargain
  // points forged — the full web's points split into 3 breakpoints.
  const DARK_FLAIRS = 3;
  const darkKeys = Math.min(DARK_FLAIRS, Math.floor(meta.darkPointsBought / ((DARK_NODES.length - 1) / DARK_FLAIRS)));
  return (
    <div className={`overlay tree-overlay dark-overlay${phase === 'seed' ? ' reveal-seed' : ''}`}>
      <div className="tree-bg dark" aria-hidden="true" style={sky} />
      {Array.from({ length: darkKeys }, (_, i) => (
        <div key={i} className={`tree-flair df${i + 1}`} aria-hidden="true" style={sky} />
      ))}
      <div className={`tree-head${phase !== 'done' ? ' veiled' : ''}`}>
        <div>
          <div className="tree-title dark">The Dark Bargain</div>
          <div className="tree-sub">Every drop of the Wound deepens the dream — crueller tides, richer stardust. The clock starts deeper, and so can your record.</div>
        </div>
        {depth > 0 && (
          <div className="depth-chip" title="Your dreams begin this far in — harder from the first breath, and the timer starts here too">
            ⇣ begins {fmtTime(depth)} deep
          </div>
        )}
        <div className="point-chip dark" title="Unspent bargain points">◈ {settings.devFreeTree ? '∞' : meta.darkPoints}</div>
        <div className="dust-big shards" title="Nightmare shards — torn from slain bosses">❖ {settings.devFreeTree ? '∞' : meta.shards}</div>
        <button
          className={`btn-secondary forge-btn dark${phase === 'done' && canBuyDarkPoint(meta) ? ' hot' : ''}`}
          disabled={!canBuyDarkPoint(meta)}
          onClick={() => clickNode('dark-core')}
          title="Feed the Wound a shard for a bargain point — each drop costs one shard more"
        >
          Feed the Wound — ❖ {nextDarkPointCost(meta)}
        </button>
        <button className="btn-secondary" onClick={onClose}>Return</button>
      </div>

      <div className="tree-wrap">
        <TreeCanvas
          nodes={DARK_NODES} edges={DARK_EDGES} nodeMap={NODE_MAP}
          owned={owned} allocatable={allocatable} removable={removable} reachable={frontier}
          phase={phase} coreHot={phase === 'done' && canBuyDarkPoint(meta)}
          variant="dark" fitRadius={470}
          pulse={pulse}
          onNodeClick={clickNode}
          onHoverNode={hoverNode}
          onRevealDone={() => { setPhase('done'); onRevealed(); }}
        />
        {tip && phase === 'done' && <NodeTip tip={tip} meta={meta} dark frontier={frontier} removable={removable} />}
      </div>

      {phase === 'seed' && (
        <div className="reveal-caption dark">
          <div className="rc-line">a wound in the dream, still weeping</div>
          <div className="rc-hint">feed it a shard</div>
        </div>
      )}
    </div>
  );
}

// A small live-painted portrait of the wizard wearing a given skin, for the
// vestment slot and its picker. Painted once per skin via the same Canvas2D
// painter the atlas bakes with, so the preview is pixel-true.
function WizardPortrait({ skin, size }: { skin: Partial<WizardSkin> | null; size: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintWizardPreview(ctx, size, skin ?? undefined);
  }, [skin, size]);
  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} />;
}

// The loadout: which spells the player carries into every run. One slot by
// default (Arcane Missiles); +1-slot notables add slots up to MAX_LOADOUT. Each
// slot is a picker over the unlocked spells; picking the blank clears the slot.
// Once any spell-evolution star is awakened, a vestment slot joins the bar:
// the wizard's skin, one per mastered evolution.
function LoadoutBar({ meta, onLoadout, onSkin, veiled }: {
  meta: Meta; onLoadout: (l: string[]) => void; onSkin: (id: string) => void; veiled?: boolean;
}) {
  const slots = loadoutSlots(meta);
  const unlocked = unlockedSpells(meta);
  const skins = useMemo(() => unlockedSkins(meta), [meta.owned, meta.cleared]);
  const loadout = meta.loadout;
  const [open, setOpen] = useState<number | 'skin' | null>(null);

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
    <div className={`loadout${veiled ? ' veiled' : ''}`}>
      <div className="loadout-label">Loadout <span className="loadout-hint">— the spells you carry into sleep</span></div>
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
                title={sp ? sp.name : 'An empty slot — click to choose a spell'}
              >
                <span className="ls-glyph">{sp ? <SpellIcon id={id} size={28} /> : '+'}</span>
              </button>
              {open === i && (
                <div className="loadout-menu">
                  {canClear && (
                    <button className="lm-item empty" onClick={() => choose(i, null)}>✕ leave empty</button>
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
          <div className="loadout-locked" title="Awaken a +1 spell slot star to widen your loadout">
            {Array.from({ length: 4 - slots }, (_, i) => <span key={i} className="ls-lock">🔒</span>)}
          </div>
        )}
        {skins.length > 0 && (
          <>
            <div className="loadout-divider" />
            <div className="loadout-slot-wrap">
              <button
                className={`loadout-slot skin-slot ${meta.skin ? 'filled' : ''}`}
                style={meta.skin ? ({ '--c': skinColor(meta.skin) } as React.CSSProperties) : undefined}
                onClick={() => setOpen(open === 'skin' ? null : 'skin')}
                title={meta.skin ? `Vestment: ${skinName(meta.skin)}` : 'Your vestment — click to choose'}
              >
                <WizardPortrait skin={meta.skin ? WIZARD_SKINS[meta.skin] : null} size={46} />
              </button>
              {open === 'skin' && (
                <div className="loadout-menu skin-menu">
                  <button
                    className={`lm-item ${meta.skin === '' ? 'active' : ''}`}
                    style={{ '--c': '#b48cff' } as React.CSSProperties}
                    onClick={() => { onSkin(''); setOpen(null); }}
                  >
                    <span className="lm-portrait"><WizardPortrait skin={null} size={34} /></span>
                    <span className="lm-name">The Old Robe</span>
                  </button>
                  {skins.map((id) => (
                    <button
                      key={id}
                      className={`lm-item ${meta.skin === id ? 'active' : ''}`}
                      style={{ '--c': skinColor(id) } as React.CSSProperties}
                      onClick={() => { onSkin(id); setOpen(null); }}
                    >
                      <span className="lm-portrait"><WizardPortrait skin={WIZARD_SKINS[id]} size={34} /></span>
                      <span className="lm-name">{skinName(id)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
