import { describe, expect, it } from 'vitest';

import { RandomAi } from '../src/ai/random-ai.js';

describe('RandomAi', () => {
    it('picks only usable moves', () => {
        const ai = new RandomAi(() => 0.99);
        const choice = ai.choose({
            active: [{ moves: [{ id: 'a', pp: 5 }, { id: 'b', pp: 0 }, { id: 'c', pp: 3, disabled: true }] }],
        });
        expect(choice).toBe('move 1');
    });

    it('falls back to move 1 (struggle) without a usable move', () => {
        expect(new RandomAi().choose({ active: [{ moves: [{ id: 'a', pp: 0 }] }] })).toBe('move 1');
    });

    it('switches to a different healthy bench creature for each forced slot', () => {
        const ai = new RandomAi(() => 0);
        const choice = ai.choose({
            forceSwitch: [true, true],
            side: {
                pokemon: [
                    { active: true, condition: '0 fnt' },
                    { active: true, condition: '0 fnt' },
                    { condition: '0 fnt' },
                    { condition: '50/100' },
                    { condition: '20/100' },
                ],
            },
        });
        expect(choice).toBe('switch 4, switch 5');
    });

    it('passes when nothing can come in, and waits on wait requests', () => {
        const ai = new RandomAi();
        expect(ai.choose({ forceSwitch: [true], side: { pokemon: [{ active: true, condition: '0 fnt' }] } })).toBe('pass');
        expect(ai.choose({ wait: true })).toBeNull();
    });
});
