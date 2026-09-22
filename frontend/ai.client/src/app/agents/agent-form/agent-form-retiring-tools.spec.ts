import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { ReactiveFormsModule } from '@angular/forms';
import { Component, input, output } from '@angular/core';
import { AgentFormPage } from './agent-form.page';
import { AgentPreviewComponent } from './components/agent-preview.component';
import { KnowledgeBaseSectionComponent } from '../../knowledge-base/knowledge-base-section.component';
import { AgentService } from '../services/agent.service';
import { SidenavService } from '../../services/sidenav/sidenav.service';
import { ThemeService } from '../../components/topnav/components/theme-toggle/theme.service';
import { ToastService } from '../../services/toast/toast.service';
import { ToolService } from '../../services/tool/tool.service';

/**
 * §7 of docs/specs/mcp-server-retirement.md — the Agent Designer's half.
 *
 * Retirement's whole plan rests on existing bindings surviving untouched while
 * new ones stop. The two invariants that matter, and both are easy to break in
 * the "obvious" direction:
 *
 * 1. A retiring tool an agent ALREADY binds still reads as selected and can
 *    still be removed. Filtering it out of the palette (or refusing the toggle
 *    in both directions) would leave the author staring at a binding they cannot
 *    see and cannot delete — the exact opposite of what Stage 2 asks of them.
 * 2. A retiring tool the agent does NOT bind cannot be added.
 *
 * Neither is an access decision: the backend still lists it, still validates the
 * write, and still admits it at invoke time.
 */

@Component({ selector: 'app-agent-preview', template: '' })
class StubPreviewComponent {
  agentId = input<string | null>(null);
  name = input('');
  description = input('');
  emoji = input('');
  starters = input<string[]>([]);
  modelId = input<string | null>(null);
  isDirty = input(false);
  saving = input(false);
  canSave = input(false);
  save = output<void>();
  openFull = output<void>();
}

@Component({ selector: 'app-knowledge-base-section', template: '' })
class StubKnowledgeBaseComponent {
  entityId = input<string | null>(null);
  userPermission = input('owner');
  permissionResolved = input(false);
  createDraft = input<unknown>(null);
}

/** Being retired. Still listed, still bindable by the backend — see the header. */
const CANVAS_RETIRING = {
  kind: 'tool',
  ref: 'canvas_faculty',
  label: 'Canvas Faculty',
  description: 'Canvas LMS',
  meta: {
    protocol: 'mcp_external',
    status: 'deprecated',
    serverTools: [{ name: 'list_courses' }, { name: 'list_rubrics' }],
  },
};

const CALCULATOR = {
  kind: 'tool',
  ref: 'calculator',
  label: 'Calculator',
  description: 'Arithmetic',
  meta: { protocol: 'direct', status: 'active', serverTools: [] },
};

/** An older backend omits `meta.status` entirely. */
const LEGACY = {
  kind: 'tool',
  ref: 'fetch_url_content',
  label: 'URL Fetcher',
  description: 'Fetch a URL',
  meta: { protocol: 'direct', serverTools: [] },
};

async function mount(bindings: { kind: string; ref: string }[]): Promise<AgentFormPage> {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();

  const agentService = {
    loadBindable: vi
      .fn()
      .mockImplementation((kind: string) =>
        Promise.resolve(kind === 'tool' ? [CANVAS_RETIRING, CALCULATOR, LEGACY] : []),
      ),
    getAgent: vi.fn().mockResolvedValue({
      agentId: 'agt-1',
      name: 'Rubric Builder',
      description: 'Builds rubrics',
      instructions: 'You build rubrics.',
      visibility: 'PRIVATE',
      userPermission: 'owner',
      bindings,
    }),
    createAgent: vi.fn().mockResolvedValue({ agentId: 'agt-1' }),
    updateAgent: vi.fn().mockResolvedValue({ agentId: 'agt-1' }),
  };

  TestBed.configureTestingModule({
    imports: [ReactiveFormsModule],
    providers: [
      provideRouter([{ path: 'agents', children: [] }]),
      {
        provide: ToolService,
        useValue: { initialized: () => true, tools: () => [], loadTools: vi.fn() },
      },
      { provide: AgentService, useValue: agentService },
      {
        provide: ToastService,
        useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
      },
      { provide: SidenavService, useValue: { hide: vi.fn(), show: vi.fn() } },
      { provide: ThemeService, useValue: { isDark: () => false } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'agt-1' } } } },
    ],
  });

  TestBed.overrideComponent(AgentFormPage, {
    remove: { imports: [AgentPreviewComponent, KnowledgeBaseSectionComponent] },
    add: { imports: [StubPreviewComponent, StubKnowledgeBaseComponent] },
  });

  const fixture: ComponentFixture<AgentFormPage> = TestBed.createComponent(AgentFormPage);
  fixture.detectChanges();
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
  lastFixture = fixture;
  return fixture.componentInstance;
}

/** The fixture from the most recent `mount`, for the tests that assert on markup. */
let lastFixture: ComponentFixture<AgentFormPage> | null = null;

/**
 * Everything below asserts at the component API, which is exactly what a rewrite of
 * the picker's markup can keep passing while silently dropping every affordance the
 * author actually sees — as the chips-to-list change on this branch could have. These
 * pin the three that now live only in the template.
 */
describe('AgentFormPage — retiring tools, as rendered', () => {
  it('disables the row in the add direction and badges it', async () => {
    const component = await mount([{ kind: 'tool', ref: 'calculator' }]);
    const fixture = lastFixture!;
    component.toolsOpen.set(true);
    fixture.detectChanges();

    const row = [...fixture.nativeElement.querySelectorAll('#agent-tools-panel li')].find(
      (li: Element) => li.textContent?.includes('Canvas Faculty'),
    ) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(true);
    expect(row.textContent).toContain('retiring');
    // Inline, not a tooltip — the whole reason this section left chips behind.
    expect(row.textContent).toContain('can no longer be added');
  });

  it('leaves a bound retiring tool removable', async () => {
    const component = await mount([{ kind: 'tool', ref: 'canvas_faculty' }]);
    const fixture = lastFixture!;
    component.toolsOpen.set(true);
    fixture.detectChanges();

    const row = [...fixture.nativeElement.querySelectorAll('#agent-tools-panel li')].find(
      (li: Element) => li.textContent?.includes('Canvas Faculty'),
    ) as HTMLElement;
    expect(row.querySelector('[role="switch"]')?.hasAttribute('disabled')).toBe(false);
    expect(row.textContent).toContain('remove it from this agent');
  });

  it('shows the section notice even while the disclosure is collapsed', async () => {
    // The agent that binds a retiring tool is precisely the one that opens
    // collapsed, so a notice gated on `toolsOpen()` would never be seen.
    const component = await mount([{ kind: 'tool', ref: 'canvas_faculty' }]);
    const fixture = lastFixture!;
    expect(component.toolsOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('#agent-tools-panel')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('is being retired');
  });
});

describe('AgentFormPage — retiring tools', () => {
  describe('isToolRetiring', () => {
    let component: AgentFormPage;
    beforeEach(async () => {
      component = await mount([]);
    });

    it('is true for a non-active status', () => {
      expect(component.isToolRetiring(CANVAS_RETIRING)).toBe(true);
    });

    it('is false for an active one', () => {
      expect(component.isToolRetiring(CALCULATOR)).toBe(false);
    });

    it('treats an older backend with no meta.status as active', () => {
      expect(component.isToolRetiring(LEGACY)).toBe(false);
    });
  });

  describe('an agent that does NOT bind the retiring tool', () => {
    let component: AgentFormPage;
    beforeEach(async () => {
      component = await mount([{ kind: 'tool', ref: 'calculator' }]);
    });

    it('refuses to add it', () => {
      component.toggleTool('canvas_faculty');
      expect(component.isToolSelected('canvas_faculty')).toBe(false);
      expect([...component.selectedToolRefs()]).toEqual(['calculator']);
    });

    it('does not mark the form dirty for the refused click', () => {
      // A save button that lights up for a change that did not happen is worse
      // than an inert chip: it offers to persist nothing.
      component.toggleTool('canvas_faculty');
      expect(component.isDirty()).toBe(false);
    });

    it('still adds an active tool', () => {
      component.toggleTool('fetch_url_content');
      expect(component.isToolSelected('fetch_url_content')).toBe(true);
    });

    it('reports nothing for the section notice', () => {
      expect(component.retiringSelectedTools()).toEqual([]);
    });
  });

  describe('an agent that already binds the retiring tool', () => {
    let component: AgentFormPage;
    beforeEach(async () => {
      component = await mount([{ kind: 'tool', ref: 'canvas_faculty' }]);
    });

    it('still reads as selected', () => {
      expect(component.isToolSelected('canvas_faculty')).toBe(true);
    });

    it('names it in the section notice so the author knows to act', () => {
      expect(component.retiringSelectedTools()).toEqual(['Canvas Faculty']);
    });

    it('lets the author remove it — the whole point of the stage', () => {
      component.toggleTool('canvas_faculty');
      expect(component.isToolSelected('canvas_faculty')).toBe(false);
      expect(component.isDirty()).toBe(true);
    });

    it('cannot be re-added once removed', () => {
      component.toggleTool('canvas_faculty');
      component.toggleTool('canvas_faculty');
      expect(component.isToolSelected('canvas_faculty')).toBe(false);
    });
  });

  describe('a scoped binding to the retiring server', () => {
    let component: AgentFormPage;
    beforeEach(async () => {
      component = await mount([{ kind: 'tool', ref: 'canvas_faculty::list_rubrics' }]);
    });

    it('reads as selected — retirement is a property of the server', () => {
      expect(component.isToolSelected('canvas_faculty')).toBe(true);
      expect(component.retiringSelectedTools()).toEqual(['Canvas Faculty']);
    });

    it('lets the author remove the whole server, scoped ref and all', () => {
      component.toggleTool('canvas_faculty');
      expect([...component.selectedToolRefs()]).toEqual([]);
    });
  });
});
