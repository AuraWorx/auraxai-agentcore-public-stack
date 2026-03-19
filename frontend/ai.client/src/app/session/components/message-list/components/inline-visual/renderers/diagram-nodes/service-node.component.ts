import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  SimpleNode,
} from 'ng-diagram';
import { DiagramNodeData, COLOR_ACCENTS, STATUS_DOT_COLORS } from './diagram-node-data.interface';

@Component({
  selector: 'app-service-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <ng-diagram-port [id]="node().id + '-input-left'" type="target" side="left" />
      <div
        class="px-4 py-3 rounded-lg border-2 select-none min-w-[140px]"
        [class]="nodeClasses()"
      >
        <div class="flex items-center gap-2.5">
          <!-- Service icon placeholder -->
          <div class="size-8 shrink-0 rounded-md bg-gray-200 dark:bg-gray-600 flex items-center justify-center">
            <svg class="size-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" />
            </svg>
          </div>
          <div class="min-w-0">
            <div class="text-sm font-medium text-gray-900 dark:text-white truncate">
              {{ nodeData().label }}
            </div>
            @if (nodeData().description) {
              <div class="text-xs text-gray-500 dark:text-gray-400 truncate">
                {{ nodeData().description }}
              </div>
            }
          </div>
          @if (nodeData().status) {
            <span class="size-2.5 shrink-0 rounded-full ml-auto" [class]="statusDotClass()"></span>
          }
        </div>
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
      <ng-diagram-port [id]="node().id + '-output-right'" type="source" side="right" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class ServiceDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
  node = input.required<SimpleNode<DiagramNodeData>>();

  nodeData = computed(() => this.node().data);

  nodeClasses = computed(() => {
    const color = this.nodeData().color;
    if (color && COLOR_ACCENTS[color]) {
      return COLOR_ACCENTS[color];
    }
    return 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600';
  });

  statusDotClass = computed(() => {
    const status = this.nodeData().status;
    return status ? (STATUS_DOT_COLORS[status] ?? '') : '';
  });
}
