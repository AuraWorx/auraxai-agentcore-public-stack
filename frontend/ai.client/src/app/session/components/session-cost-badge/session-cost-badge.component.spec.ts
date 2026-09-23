import { TestBed } from '@angular/core/testing';
import { SessionCostBadgeComponent } from './session-cost-badge.component';
import { ChatStateService } from '../../services/chat/chat-state.service';
import { QuotaStatusService } from '../../../services/quota/quota-status.service';
import type { QuotaStatus } from '../../../services/quota/quota-status.model';

function quota(overrides: Partial<QuotaStatus> = {}): QuotaStatus {
  return {
    configured: true,
    unlimited: false,
    tierName: 'Standard',
    matchedBy: 'jwt_role:Faculty',
    monthlyLimit: 10,
    currentUsage: 2.5,
    remaining: 7.5,
    usagePercentage: 25,
    periodType: 'monthly',
    resetInfo: 'Quota resets in 12 day(s)',
    hasActiveOverride: false,
    ...overrides,
  };
}

describe('SessionCostBadgeComponent quota tooltip', () => {
  let quotaValue: QuotaStatus | undefined;

  function build() {
    const chatStub = {
      costDollars: () => 0.4175,
      costDollarsFor: () => 0.4175,
      contextTokens: () => 1000,
      contextTokensFor: () => 1000,
      contextWindowSize: () => 200000,
      contextWindowFor: () => 200000,
      contextPct: () => 8,
      contextPctFor: () => 8,
    };
    const quotaStub = { status: { value: () => quotaValue } };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStateService, useValue: chatStub },
        { provide: QuotaStatusService, useValue: quotaStub },
      ],
    });
    const fixture = TestBed.createComponent(SessionCostBadgeComponent);
    fixture.detectChanges();
    return fixture.componentInstance as unknown as {
      quotaInfo: () => ReturnType<any> | null;
      quotaUnlimited: () => boolean;
      hasQuotaTooltip: () => boolean;
      quotaPctClass: () => string;
      costAriaLabel: () => string;
    };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('exposes quota breakdown labels for a normal tier', () => {
    quotaValue = quota();
    const c = build();
    const q = c.quotaInfo()!;
    expect(q.pctLabel).toBe('25%');
    expect(q.usageLabel).toBe('$2.50');
    expect(q.limitLabel).toBe('$10.00');
    expect(q.remainingLabel).toBe('$7.50');
    expect(q.periodWord).toBe('month');
    expect(c.hasQuotaTooltip()).toBe(true);
    expect(c.quotaPctClass()).toContain('success');
  });

  it('turns the percentage red at/above 90%', () => {
    quotaValue = quota({ usagePercentage: 95, currentUsage: 9.5, remaining: 0.5 });
    const c = build();
    expect(c.quotaPctClass()).toContain('danger');
  });

  it('reports unlimited with no breakdown', () => {
    quotaValue = quota({ unlimited: true, monthlyLimit: null });
    const c = build();
    expect(c.quotaInfo()).toBeNull();
    expect(c.quotaUnlimited()).toBe(true);
    expect(c.hasQuotaTooltip()).toBe(true);
    expect(c.costAriaLabel()).toContain('Unlimited');
  });

  it('has no tooltip when quota is unconfigured', () => {
    quotaValue = quota({ configured: false, monthlyLimit: null });
    const c = build();
    expect(c.quotaInfo()).toBeNull();
    expect(c.quotaUnlimited()).toBe(false);
    expect(c.hasQuotaTooltip()).toBe(false);
  });

  it('folds monthly quota into the accessible label', () => {
    quotaValue = quota();
    const c = build();
    expect(c.costAriaLabel()).toContain('Monthly quota');
    expect(c.costAriaLabel()).toContain('$10.00');
  });
});

describe('SessionCostBadgeComponent cost count-up', () => {
  let cost: number;

  function build() {
    const chatStub = {
      costDollars: () => cost,
      costDollarsFor: () => cost,
      contextTokens: () => 1000,
      contextTokensFor: () => 1000,
      contextWindowSize: () => 200000,
      contextWindowFor: () => 200000,
      contextPct: () => 8,
      contextPctFor: () => 8,
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStateService, useValue: chatStub },
        { provide: QuotaStatusService, useValue: { status: { value: () => undefined } } },
      ],
    });
    const fixture = TestBed.createComponent(SessionCostBadgeComponent);
    fixture.detectChanges();
    return fixture.componentInstance as unknown as {
      cost: () => number;
      displayedCost: () => number;
      costLabel: () => string;
      displayedCostLabel: () => string;
      scheduleCountUp: (target: number, delayMs: number) => void;
    };
  }

  /** Run `fn` with `prefers-reduced-motion: reduce`, so counts snap. */
  function withReducedMotion(fn: () => void): void {
    const holder = window as unknown as { matchMedia?: unknown };
    const original = holder.matchMedia;
    holder.matchMedia = (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      fn();
    } finally {
      if (original === undefined) delete holder.matchMedia;
      else holder.matchMedia = original;
    }
  }

  afterEach(() => TestBed.resetTestingModule());

  it('starts the tally at zero while the settled total is already known', () => {
    cost = 0.4175;
    const c = build();
    expect(c.displayedCost()).toBe(0);
    expect(c.displayedCostLabel()).toBe('$0.0000');
    // The accessible/settled label never lags behind the animation.
    expect(c.costLabel()).toBe('$0.4175');
  });

  it('formats the tally with the digit count the target warrants', () => {
    // A tally climbing towards $1.05 passes through $0.98: two decimals for
    // both, so the badge does not reflow from four digits to two mid-count.
    cost = 1.05;
    withReducedMotion(() => {
      const c = build();
      c.scheduleCountUp(0.98, 0);
      expect(c.displayedCostLabel()).toBe('$0.98');
      expect(c.costLabel()).toBe('$1.05');
    });
  });

  it('tallies through intermediate values and lands exactly on the total', () => {
    // Drive the frame loop by hand so the count is deterministic. Other
    // frames (the ring's entrance) share the queue, so each tick drains it.
    const frames: FrameRequestCallback[] = [];
    const originalRaf = globalThis.requestAnimationFrame;
    const originalNow = performance.now;
    let clock = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
      frames.push(cb)) as unknown as typeof requestAnimationFrame;
    performance.now = () => clock;
    const tick = (now: number) => {
      clock = now;
      for (const cb of frames.splice(0, frames.length)) cb(now);
    };

    try {
      cost = 2;
      const c = build();
      frames.length = 0;
      c.scheduleCountUp(2, 0);

      tick(100);
      const midway = c.displayedCost();
      expect(midway).toBeGreaterThan(0);
      expect(midway).toBeLessThan(2);

      // Past the duration the tally settles on the exact figure, not an
      // eased approximation of it.
      tick(5000);
      expect(c.displayedCost()).toBe(2);
      expect(c.displayedCostLabel()).toBe('$2.00');
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
      performance.now = originalNow;
    }
  });

  it('snaps instead of counting down when the target drops', () => {
    // A lower total means a different conversation is in view, not a refund.
    cost = 5;
    withReducedMotion(() => {
      const c = build();
      c.scheduleCountUp(5, 0);
      expect(c.displayedCost()).toBe(5);
      c.scheduleCountUp(1, 0);
      expect(c.displayedCost()).toBe(1);
    });
  });

  it('snaps when the viewer prefers reduced motion', () => {
    cost = 3.5;
    withReducedMotion(() => {
      const c = build();
      c.scheduleCountUp(3.5, 0);
      expect(c.displayedCost()).toBe(3.5);
    });
  });
});
