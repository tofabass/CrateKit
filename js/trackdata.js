/* DJ Brain — master crate: TOFA "Originals Set" (25 tracks, set order) */
(function () {
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(20261117);

  // [title, artist, bpm, camelot]  — in actual set order
  const RAW = [
    ["Why Don't You (Listen) WIP", 'TOFA', 70, '5A'],
    ['DUSK', 'TOFA', 140, '5A'],
    ['Pump', 'TOFA', 70, '5A'],
    ['Flex it Flip v2', 'TOFA', 140, '9A'],
    ['Turn Up V1', 'TOFA', 140, '5A'],
    ['Shake v1', 'TOFA', 140, '9A'],
    ['Everybody WIP', 'TOFA', 70, '11A'],
    ['Get a Load', 'TOFA', 140, '11A'],
    ['Witches v3', 'TOFA x Internal Frequency', 140, '7A'],
    ['Got That', 'TOFA', 140, '7A'],
    ["Don't Play v2", 'TOFA', 140, '9A'],
    ['Heavy', 'TOFA & RYNGO', 140, '3A'],
    ["Pa' ca", 'TOFA', 140, '3A'],
    ['2Nite Final', 'TOFA', 140, '3A'],
    ['4AM Flip Vocal Edit', 'TOFA', 140, '3A'],
    ['Feel It', 'TOFA', 136, '5A'],
    ['Jump Around Flip V1', 'TOFA', 140, '5A'],
    ['Trigger Warning Flip', 'TOFA', 140, '9A'],
    ['Say Less (Edit Long)', 'TOFA', 130, '7A'],
    ['Rude', 'TOFA', 140, '10B'],
    ['SoUKno', 'TOFA', 70, '3B'],
    ['Golden Hour', 'TOFA & Zadoz', 66, '8A'],
    ['Smoke Alarm v1', 'TOFA', 140, '1A'],
    ['Tuna Dub v2', 'TOFA', 140, '9A'],
    ['Smoke Alarm v3', 'TOFA', 140, '5B'],
  ];

  // Real 30s previews (25s-55s of each source file) in dj-brain/previews/.
  // Tracked by set order: preview_NN_<slug>.mp3
  const PREVIEWS = {
    "Why Don't You (Listen) WIP": 'preview_01_why_dont_you.mp3',
    'DUSK': 'preview_02_dusk_v2.mp3',
    'Pump': 'preview_03_pump.mp3',
    'Flex it Flip v2': 'preview_04_flex_it_flip_v2.mp3',
    'Turn Up V1': 'preview_05_turn_up_v1.mp3',
    'Shake v1': 'preview_06_shake_v1.mp3',
    'Everybody WIP': 'preview_07_everybody.mp3',
    'Get a Load': 'preview_08_get_a_load.mp3',
    'Witches v3': 'preview_09_witches_v3.mp3',
    'Got That': 'preview_10_got_that.mp3',
    "Don't Play v2": 'preview_11_dont_play_v2.mp3',
    'Heavy': 'preview_12_heavy.mp3',
    "Pa' ca": 'preview_13_pa_ca.mp3',
    '2Nite Final': 'preview_14_2nite_final.mp3',
    '4AM Flip Vocal Edit': 'preview_15_4am_flip_vocal_edit.mp3',
    'Feel It': 'preview_16_feel_it.mp3',
    'Jump Around Flip V1': 'preview_17_jump_around_flip_v1.mp3',
    'Trigger Warning Flip': 'preview_18_trigger_warning_flip.mp3',
    'Say Less (Edit Long)': 'preview_19_say_less_edit_long.mp3',
    'Rude': 'preview_20_rude.mp3',
    'SoUKno': 'preview_21_soukno.mp3',
    'Golden Hour': 'preview_22_golden_hour.mp3',
    'Smoke Alarm v1': 'preview_23_smoke_alarm_v1.mp3',
    'Tuna Dub v2': 'preview_24_tuna_dub_v2.mp3',
    'Smoke Alarm v3': 'preview_25_smoke_alarm_v3.mp3',
  };

  const tracks = RAW.map((r, i) => {
    const slow = r[2] < 120;
    // energy: slow originals sit low (2-5), drum tracks high (6-10); seeded jitter
    const energy = slow ? 2 + Math.floor(rng() * 4) : 6 + Math.floor(rng() * 5);
    return {
      id: 't' + i,
      title: r[0],
      artist: r[1],
      genre: slow ? '70s Ballads' : '140s',
      camelot: r[3],
      energy,
      bpm: r[2],
      audioFile: PREVIEWS[r[0]] ? 'previews/' + PREVIEWS[r[0]] : null,
    };
  });

  function keyClose(a, b) {
    const na = parseInt(a), nb = parseInt(b);
    const d = Math.abs(na - nb);
    return d === 0 || d === 1 || d === 11;
  }

  const edges = [];
  const seen = new Set();
  const addEdge = (a, b, freq) => {
    if (a === b) return false;
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(k)) return false;
    seen.add(k);
    edges.push({ a, b, freq });
    return true;
  };

  // 1) proven transitions: the set was played in this exact order
  for (let i = 0; i < tracks.length - 1; i++) {
    addEdge('t' + i, 't' + (i + 1), 40 + Math.floor(55 * rng() * rng()));
  }

  // 2) crate logic: same tempo family + compatible Camelot key => likely transitioned
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 2; j < tracks.length; j++) { // skip chain neighbors
      const a = tracks[i], b = tracks[j];
      if (Math.abs(a.bpm - b.bpm) > 12) continue;
      if (!keyClose(a.camelot, b.camelot)) continue;
      if (rng() < 0.5) {
        addEdge(a.id, b.id, 5 + Math.floor(50 * rng() * rng()));
      }
    }
  }

  // 3) a locked crate pairing that completes a 3-way shared-neighbor triangle:
  //    Flex it Flip v2 & Shake v1 now share Don't Play v2, Turn Up V1, Trigger Warning Flip
  addEdge('t3', 't17', 45);

  const playlists = {
    '140s Set': tracks.filter(t => t.bpm >= 120).map(t => t.id),
    'Slow Set': tracks.filter(t => t.bpm < 120).map(t => t.id),
  };

  window.BRAIN_DATA = { tracks, edges, playlists };
})();
