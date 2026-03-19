import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  SimpleNode,
} from 'ng-diagram';
import { DiagramNodeData, COLOR_ACCENTS, STATUS_DOT_COLORS } from './diagram-node-data.interface';

@Component({
  selector: 'app-default-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <div
        class="px-4 py-3 rounded-lg border text-center select-none min-w-[100px]"
        [class]="nodeClasses()"
      >
        <div class="text-sm font-medium text-gray-900 dark:text-white truncate">
          {{ nodeData().label }}
        </div>
        @if (nodeData().description) {
          <div class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
            {{ nodeData().description }}
          </div>
        }
        @if (nodeData().status) {
          <div class="flex items-center justify-center gap-1.5 mt-1.5">
            <span class="size-2 rounded-full" [class]="statusDotClass()"></span>
            <span class="text-[10px] text-gray-500 dark:text-gray-400 capitalize">
              {{ nodeData().status }}
            </span>
          </div>
        }
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class DefaultDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
  node = input.required<SimpleNode<DiagramNodeData>>();

  nodeData = computed(() => this.node().data);

  nodeClasses = computed(() => {
    const color = this.nodeData().color;
    if (color && COLOR_ACCENTS[color]) {
      return COLOR_ACCENTS[color];
    }
    return 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700';
  });

  statusDotClass = computed(() => {
    const status = this.nodeData().status;
    return status ? (STATUS_DOT_COLORS[status] ?? '') : '';
  });
}
