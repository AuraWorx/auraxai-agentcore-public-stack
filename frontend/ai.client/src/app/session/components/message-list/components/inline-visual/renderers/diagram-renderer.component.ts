import {
  Component,
  input,
  output,
  computed,
  effect,
  signal,
  ChangeDetectionStrategy,
  Injector,
  inject,
  viewChild,
  ElementRef,
} from '@angular/core';
import {
  NgDiagramComponent,
  NgDiagramBackgroundComponent,
  NgDiagramNodeTemplateMap,
  NgDiagramConfig,
  ModelAdapter,
  SimpleNode,
  Edge,
  initializeModel,
  provideNgDiagram,
  NgDiagramViewportService,
} from 'ng-diagram';
import {
  DefaultDiagramNodeComponent,
  ProcessDiagramNodeComponent,
  DecisionDiagramNodeComponent,
  StartDiagramNodeComponent,
  EndDiagramNodeComponent,
  DatabaseDiagramNodeComponent,
  ServiceDiagramNodeComponent,
  GroupDiagramNodeComponent,
  DiagramNodeData,
} from './diagram-nodes';
import { TooltipDirective } from '../../../../../../components/tooltip/tooltip.directive';

/** Payload structure from the backend diagram tool */
export interface DiagramPayload {
  diagramType: 'flowchart' | 'architecture' | 'org_chart' | 'sequence' | 'mindmap' | 'custom';
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  config?: DiagramConfigPayload;
}

interface DiagramNode {
  id: string;
  type: string;
  data: DiagramNodeData;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  ports?: DiagramPort[];
}

interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  sourcePort?: string;
  targetPort?: string;
  label?: string;
  routing?: string;
  data?: Record<string, unknown>;
}

interface DiagramPort {
  id: string;
  type: 'source' | 'target' | 'both';
  side: 'top' | 'right' | 'bottom' | 'left';
}

interface DiagramConfigPayload {
  defaultRouting?: string;
  direction?: string;
  spacing?: { x: number; y: number };
}

/** Node template map binding type strings to Angular components */
function createNodeTemplateMap(): NgDiagramNodeTemplateMap {
  const map = new NgDiagramNodeTemplateMap();
  map.set('default', DefaultDiagramNodeComponent);
  map.set('process', ProcessDiagramNodeComponent);
  map.set('decision', DecisionDiagramNodeComponent);
  map.set('start', StartDiagramNodeComponent);
  map.set('end', EndDiagramNodeComponent);
  map.set('database', DatabaseDiagramNodeComponent);
  map.set('service', ServiceDiagramNodeComponent);
  map.set('group', GroupDiagramNodeComponent);
  return map;
}

@Component({
  selector: 'app-diagram-renderer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramComponent, NgDiagramBackgroundComponent, TooltipDirective],
  providers: [provideNgDiagram()],
  template: `
    <dialog #diagramDialog
            class="diagram-dialog rounded-lg border border-gray-200 dark:border-gray-700
                   bg-white dark:bg-gray-800 overflow-hidden"
            open>
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        @if (diagramPayload()?.title) {
          <h4 class="text-sm font-medium text-gray-900 dark:text-white">
            {{ diagramPayload()!.title }}
          </h4>
        } @else {
          <span class="text-sm text-gray-500 dark:text-gray-400">Diagram</span>
        }

        <div class="flex items-center gap-1">
          @if (isExpanded() && diagramReady()) {
            <button
              type="button"
              (click)="zoomIn()"
              class="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400
                     dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700
                     disabled:opacity-40 disabled:pointer-events-none"
              [disabled]="!viewportService.canZoomIn()"
              aria-label="Zoom in"
              [appTooltip]="'Zoom in'"
              appTooltipPosition="top"
            >
              <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M12 6v12M6 12h12" />
              </svg>
            </button>

            <button
              type="button"
              (click)="zoomOut()"
              class="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400
                     dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700
                     disabled:opacity-40 disabled:pointer-events-none"
              [disabled]="!viewportService.canZoomOut()"
              aria-label="Zoom out"
              [appTooltip]="'Zoom out'"
              appTooltipPosition="top"
            >
              <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M6 12h12" />
              </svg>
            </button>

            <button
              type="button"
              (click)="fitToView()"
              class="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400
                     dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="Fit to view"
              [appTooltip]="'Fit to view'"
              appTooltipPosition="top"
            >
              <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M4 8V4h4M16 4h4v4M4 16v4h4M16 20h4v-4" />
              </svg>
            </button>

            <button
              type="button"
              (click)="toggleMaximize()"
              class="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400
                     dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
              [attr.aria-label]="maximized() ? 'Exit fullscreen' : 'Maximize'"
              [appTooltip]="maximized() ? 'Exit fullscreen' : 'Maximize'"
              appTooltipPosition="top"
            >
              <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                @if (maximized()) {
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M9 4v4H5M15 4v4h4M9 20v-4H5M15 20v-4h4" />
                } @else {
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M3 7V3h4M17 3h4v4M3 17v4h4M17 21h4v-4" />
                }
              </svg>
            </button>

            <div class="w-px h-4 bg-gray-300 dark:bg-gray-600" role="separator"></div>
          }

          <button
            type="button"
            (click)="toggleExpanded.emit()"
            class="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400
                   dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            [attr.aria-label]="isExpanded() ? 'Collapse' : 'Expand'"
            [appTooltip]="isExpanded() ? 'Collapse' : 'Expand'"
            appTooltipPosition="top"
          >
            <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              @if (isExpanded()) {
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M5 15l7-7 7 7" />
              } @else {
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M19 9l-7 7-7-7" />
              }
            </svg>
          </button>

          <button
            type="button"
            (click)="dismiss.emit()"
            class="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400
                   dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="Dismiss"
            [appTooltip]="'Dismiss'"
            appTooltipPosition="top"
          >
            <svg class="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Diagram Canvas -->
      @if (isExpanded() && model()) {
        <div class="diagram-canvas" [class.diagram-canvas-maximized]="maximized()">
          <ng-diagram
            [model]="model()!"
            [config]="diagramConfig()"
            [nodeTemplateMap]="nodeTemplateMap"
            (diagramInit)="onDiagramInit()"
          >
            <ng-diagram-background />
          </ng-diagram>
        </div>
      }
    </dialog>
  `,
  styles: `
    :host {
      display: block;
    }
    .diagram-dialog {
      /* Reset default dialog styles */
      padding: 0;
      border: none;
      max-width: none;
      max-height: none;
      color: inherit;
    }
    /* Inline mode: displayed as a normal block element */
    .diagram-dialog[open]:not(:modal) {
      display: block;
      position: static;
      width: 100%;
    }
    /* Modal/maximized mode via showModal() */
    .diagram-dialog:modal {
      width: calc(100vw - 48px);
      height: calc(100dvh - 48px);
    }
    .diagram-dialog::backdrop {
      background: rgba(0, 0, 0, 0.5);
    }
    .diagram-canvas {
      width: 100%;
      height: 400px;
      position: relative;
    }
    .diagram-canvas-maximized {
      height: calc(100dvh - 48px - 49px);
    }
  `,
})
export class DiagramRendererComponent {
  /** The diagram payload from the backend */
  payload = input.required<unknown>();

  /** Whether the diagram is expanded */
  isExpanded = input<boolean>(true);

  /** Emitted when user dismisses the diagram */
  dismiss = output<void>();

  /** Emitted when user toggles expand/collapse */
  toggleExpanded = output<void>();

  private readonly injector = inject(Injector);
  readonly viewportService = inject(NgDiagramViewportService);

  private readonly dialogRef = viewChild.required<ElementRef<HTMLDialogElement>>('diagramDialog');

  /** Node template map for ng-diagram */
  readonly nodeTemplateMap = createNodeTemplateMap();

  /** The initialized model adapter */
  model = signal<ModelAdapter | null>(null);

  /** Whether the diagram engine has fully initialized */
  diagramReady = signal(false);

  /** Whether the diagram is in maximized/fullscreen mode */
  maximized = signal(false);

  /** Parse and validate the payload */
  diagramPayload = computed<DiagramPayload | null>(() => {
    const raw = this.payload();
    if (!raw || typeof raw !== 'object') return null;

    const p = raw as DiagramPayload;
    if (!p.nodes || !Array.isArray(p.nodes)) return null;

    return p;
  });

  /** Build ng-diagram config from payload */
  diagramConfig = computed<NgDiagramConfig>(() => {
    const payload = this.diagramPayload();
    const config: NgDiagramConfig = {
      edgeRouting: {
        defaultRouting: this.getRoutingForType(payload?.config?.defaultRouting ?? payload?.diagramType),
      },
      zoom: {
        min: 0.3,
        max: 3,
      },
    };
    return config;
  });

  constructor() {
    effect(() => {
      const payload = this.diagramPayload();
      const expanded = this.isExpanded();

      if (payload && expanded && !this.model()) {
        // Schedule outside reactive context — initializeModel internally uses effect()
        queueMicrotask(() => this.initializeDiagramModel(payload));
      }
    });
  }

  onDiagramInit(): void {
    this.diagramReady.set(true);
    this.viewportService.zoomToFit({ padding: 40 });
  }

  zoomIn(): void {
    this.viewportService.zoom(1.2);
  }

  zoomOut(): void {
    this.viewportService.zoom(0.8);
  }

  fitToView(): void {
    this.viewportService.zoomToFit({ padding: 40 });
  }

  toggleMaximize(): void {
    const dialog = this.dialogRef().nativeElement;
    if (this.maximized()) {
      dialog.close();
      dialog.setAttribute('open', '');
      this.maximized.set(false);
    } else {
      dialog.removeAttribute('open');
      dialog.showModal();
      this.maximized.set(true);
    }
    // Re-fit after the container resizes
    requestAnimationFrame(() => this.viewportService.zoomToFit({ padding: 40 }));
  }

  private initializeDiagramModel(payload: DiagramPayload): void {
    const nodes: SimpleNode<DiagramNodeData>[] = payload.nodes.map((n) => ({
      id: n.id,
      type: n.type || 'default',
      position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
      data: n.data ?? { label: n.id },
      size: n.width && n.height ? { width: n.width, height: n.height } : undefined,
      autoSize: !(n.width && n.height),
    }));

    const edges: Edge[] = (payload.edges ?? []).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourcePort: e.sourcePort,
      targetPort: e.targetPort,
      data: e.data ?? {},
      routing: e.routing as Edge['routing'],
    }));

    try {
      const adapter = initializeModel(
        { nodes, edges },
        this.injector,
      );
      this.model.set(adapter);
    } catch (err) {
      console.error('Failed to initialize diagram model:', err);
    }
  }

  private getRoutingForType(type?: string): string {
    switch (type) {
      case 'flowchart':
      case 'org_chart':
      case 'sequence':
      case 'orthogonal':
        return 'orthogonal';
      case 'polyline':
        return 'polyline';
      default:
        return 'bezier';
    }
  }
}
