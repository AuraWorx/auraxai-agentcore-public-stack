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
 * Binding a subset of an MCP server's tools.
 *
 * The selection model is the thing worth pinning down: `selectedToolRefs` holds the
 * `binding.ref` values verbatim, and the invariant is that a fully-selected server is
 * stored as the **bare** ref rather than as N scoped ones. Get that wrong and every
 * existing agent's bindings silently rewrite themselves the first time someone opens
 * the form — a different record, for no change the author made.
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

const CANVAS = {
  kind: 'tool',
  ref: 'canvas_faculty',
  label: 'Canvas Faculty',
  description: 'Canvas LMS',
  meta: {
    protocol: 'mcp_external',
    serverTools: [
      { name: 'list_courses', description: 'List courses.\n\nArgs:\n  term: the term' },
      { name: 'list_rubrics', description: 'List rubrics.' },
      { name: 'grade_submission', description: 'Grade a submission.' },
    ],
  },
};

/** A local tool: nothing to narrow, so it must never offer the per-tool control. */
const CALCULATOR = {
  kind: 'tool',
  ref: 'calculator',
  label: 'Calculator',
  description: 'Arithmetic',
  meta: { protocol: 'direct', serverTools: [] },
};

async function settle(fixture: ComponentFixture<AgentFormPage>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
}

async function mount(
  bindings: { kind: string; ref: string }[],
  agentId: string | null = 'agt-1',
): Promise<{
  fixture: ComponentFixture<AgentFormPage>;
  component: AgentFormPage;
}> {
  TestBed.resetTestingModule();
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();

  const agentService = {
    loadBindable: vi
      .fn()
      .mockImplementation((kind: string) =>
        Promise.resolve(kind === 'tool' ? [CANVAS, CALCULATOR] : []),
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
      // The create-mode form injects ToolService; stub it so the root service's
      // constructor doesn't attempt a (blocked) real GET /tools/.
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
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => agentId } } } },
    ],
  });

  TestBed.overrideComponent(AgentFormPage, {
    remove: { imports: [AgentPreviewComponent, KnowledgeBaseSectionComponent] },
    add: { imports: [StubPreviewComponent, StubKnowledgeBaseComponent] },
  });

  const fixture = TestBed.createComponent(AgentFormPage);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle(fixture);
  return { fixture, component: fixture.componentInstance };
}

/** The refs the form would submit, order-insensitive. */
function refs(component: AgentFormPage): string[] {
  return [...component.selectedToolRefs()].sort();
}

describe('AgentFormPage — scoped tool bindings', () => {
  let fixture: ComponentFixture<AgentFormPage>;
  let component: AgentFormPage;

  describe('a whole-server binding', () => {
    beforeEach(async () => {
      ({ fixture, component } = await mount([{ kind: 'tool', ref: 'canvas_faculty' }]));
    });

    it('reads as selected with every tool on', () => {
      expect(component.isToolSelected('canvas_faculty')).toBe(true);
      expect(component.isWholeServerSelected(CANVAS)).toBe(true);
      expect(component.isServerToolSelected('canvas_faculty', 'grade_submission')).toBe(true);
    });

    it('stays the bare ref when nothing is touched', () => {
      expect(refs(component)).toEqual(['canvas_faculty']);
    });

    it('narrows to scoped refs when one tool is turned off', () => {
      component.toggleServerTool(CANVAS, 'grade_submission');
      expect(refs(component)).toEqual([
        'canvas_faculty::list_courses',
        'canvas_faculty::list_rubrics',
      ]);
      expect(component.isServerToolSelected('canvas_faculty', 'grade_submission')).toBe(false);
      expect(component.selectedServerToolCount(CANVAS)).toBe(2);
    });

    it('collapses back to the bare ref when the last tool is turned on again', () => {
      component.toggleServerTool(CANVAS, 'grade_submission');
      component.toggleServerTool(CANVAS, 'grade_submission');
      expect(refs(component)).toEqual(['canvas_faculty']);
    });

    it('deselects the server when its last tool is turned off', () => {
      for (const name of ['list_courses', 'list_rubrics', 'grade_submission']) {
        component.toggleServerTool(CANVAS, name);
      }
      expect(refs(component)).toEqual([]);
      expect(component.isToolSelected('canvas_faculty')).toBe(false);
    });
  });

  describe('a scoped binding', () => {
    beforeEach(async () => {
      ({ fixture, component } = await mount([
        { kind: 'tool', ref: 'canvas_faculty::list_courses' },
        { kind: 'tool', ref: 'canvas_faculty::list_rubrics' },
      ]));
    });

    it('hydrates its refs verbatim', () => {
      expect(refs(component)).toEqual([
        'canvas_faculty::list_courses',
        'canvas_faculty::list_rubrics',
      ]);
    });

    it('shows the server as selected but not whole', () => {
      expect(component.isToolSelected('canvas_faculty')).toBe(true);
      expect(component.isWholeServerSelected(CANVAS)).toBe(false);
      expect(component.selectedServerToolCount(CANVAS)).toBe(2);
    });

    it('leaves the unselected tool off', () => {
      expect(component.isServerToolSelected('canvas_faculty', 'grade_submission')).toBe(false);
    });

    it('drops every scoped ref when the server chip is deselected', () => {
      component.toggleTool('canvas_faculty');
      expect(refs(component)).toEqual([]);
    });

    it('re-selecting the chip binds the whole server again', () => {
      component.toggleTool('canvas_faculty');
      component.toggleTool('canvas_faculty');
      expect(refs(component)).toEqual(['canvas_faculty']);
    });

    it('renders the per-tool rows once expanded', async () => {
      // A saved agent with tools opens collapsed, so the panel has to be opened
      // before its rows exist at all — see `toolsOpen`.
      component.toolsOpen.set(true);
      component.toggleToolExpanded('canvas_faculty');
      fixture.detectChanges();
      // Scoped to the server's own panel: the parent rows are switches too now, so
      // a document-wide count would measure the catalog rather than the sub-tools.
      const panel = fixture.nativeElement.querySelector('#agent-server-tools-canvas_faculty');
      expect(panel).not.toBeNull();
      expect(panel.querySelectorAll('[role="switch"]').length).toBe(3);
      expect(panel.textContent).toContain('grade_submission');
      // `2 of 3` on the row, so the narrowing is legible without expanding.
      expect(fixture.nativeElement.textContent).toContain('2 of 3');
    });

    it('splits a docstring into summary and Args: detail, like the chat picker', () => {
      const listCourses = component.serverTools(CANVAS)[0];
      expect(listCourses.summary).toBe('List courses.');
      expect(listCourses.detail).toContain('Args:');
    });
  });

  /**
   * The Tools section is a disclosure, and the default it opens at is the whole
   * design: closed is only right when there is a summary to close *to*. A saved
   * agent gets its one-line answer; a new or empty one keeps the list in front of
   * the author, who otherwise has no way to learn what the platform can do.
   */
  describe('the Tools disclosure', () => {
    it('opens collapsed for a saved agent that already has tools', async () => {
      ({ component } = await mount([{ kind: 'tool', ref: 'canvas_faculty' }]));
      expect(component.toolsOpen()).toBe(false);
      expect(component.selectedToolCount()).toBe(1);
      expect(component.selectedToolSummary()).toBe('Canvas Faculty');
    });

    it('stays open for a saved agent with no tools bound', async () => {
      ({ component } = await mount([]));
      expect(component.toolsOpen()).toBe(true);
      expect(component.selectedToolSummary()).toBe('');
    });

    it('stays open in create mode', async () => {
      ({ component } = await mount([], null));
      expect(component.mode()).toBe('create');
      expect(component.toolsOpen()).toBe(true);
    });

    it('caps the summary at three names', async () => {
      ({ component } = await mount([
        { kind: 'tool', ref: 'canvas_faculty' },
        { kind: 'tool', ref: 'calculator' },
      ]));
      // Alphabetical, so the header does not reorder itself between visits.
      expect(component.selectedToolSummary()).toBe('Calculator, Canvas Faculty');
    });
  });

  describe('the Tools list', () => {
    beforeEach(async () => {
      ({ fixture, component } = await mount([]));
    });

    it('groups by catalog category, sorted', () => {
      // CANVAS has no `category` on its meta, so both fall to the `Other` bucket —
      // which is the point of the fallback: an uncategorised tool still has a home.
      const groups = component.toolGroups();
      expect(groups.map((g) => g.category)).toEqual(['Other']);
      expect(groups[0].items.map((i) => i.label)).toEqual(['Calculator', 'Canvas Faculty']);
    });

    it('filters on label, description and category', () => {
      component.toolQuery.set('canvas');
      expect(component.toolGroups().flatMap((g) => g.items.map((i) => i.ref))).toEqual([
        'canvas_faculty',
      ]);

      // Description, not label: Calculator's description is "Arithmetic".
      component.toolQuery.set('arithmetic');
      expect(component.toolGroups().flatMap((g) => g.items.map((i) => i.ref))).toEqual([
        'calculator',
      ]);
    });

    it('renders an empty state rather than a blank list when nothing matches', () => {
      component.toolQuery.set('zzz-no-such-tool');
      fixture.detectChanges();
      expect(component.toolGroups()).toEqual([]);
      expect(fixture.nativeElement.textContent).toContain('No tools match');
    });
  });

  describe('a tool with no discovered list', () => {
    beforeEach(async () => {
      ({ fixture, component } = await mount([{ kind: 'tool', ref: 'calculator' }]));
    });

    it('offers no per-tool control', () => {
      expect(component.canScopeTool(CALCULATOR)).toBe(false);
    });

    it('toggles as a plain whole-tool binding', () => {
      component.toggleTool('calculator');
      expect(refs(component)).toEqual([]);
      component.toggleTool('calculator');
      expect(refs(component)).toEqual(['calculator']);
    });
  });
});
