import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  SimpleNode,
} from 'ng-diagram';
import { DiagramNodeData, COLOR_ACCENTS, STATUS_DOT_COLORS } from './diagram-node-data.interface';

@Component({
  selector: 'app-process-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <div
        class="px-4 py-3 rounded-sm border-2 select-none min-w-[120px]"
        [class]="nodeClasses()"
      >
        <div class="flex items-center gap-2">
          @if (nodeData().status) {
            <span class="size-2 shrink-0 rounded-full" [class]="statusDotClass()"></span>
          }
          <span class="text-sm font-medium text-gray-900 dark:text-white truncate">
            {{ nodeData().label }}
          </span>
        </div>
        @if (nodeData().description) {
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
            {{ nodeData().description }}
          </div>
        }
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class ProcessDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
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
