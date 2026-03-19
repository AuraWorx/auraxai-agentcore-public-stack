import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  SimpleNode,
} from 'ng-diagram';
import { DiagramNodeData, STATUS_DOT_COLORS } from './diagram-node-data.interface';

@Component({
  selector: 'app-database-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <div class="select-none min-w-[120px] flex flex-col items-center">
        <!-- Cylinder top cap -->
        <div class="w-full h-4 rounded-t-[50%] border-2 border-b-0 border-indigo-300 dark:border-indigo-500
                    bg-indigo-100 dark:bg-indigo-900/40"></div>
        <!-- Cylinder body -->
        <div class="w-full border-x-2 border-indigo-300 dark:border-indigo-500
                    bg-indigo-50 dark:bg-indigo-900/20 px-4 py-2 text-center">
          <div class="flex items-center justify-center gap-1.5">
            @if (nodeData().status) {
              <span class="size-2 shrink-0 rounded-full" [class]="statusDotClass()"></span>
            }
            <span class="text-sm font-medium text-gray-900 dark:text-white truncate">
              {{ nodeData().label }}
            </span>
          </div>
          @if (nodeData().description) {
            <div class="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
              {{ nodeData().description }}
            </div>
          }
        </div>
        <!-- Cylinder bottom cap -->
        <div class="w-full h-4 rounded-b-[50%] border-2 border-t-0 border-indigo-300 dark:border-indigo-500
                    bg-indigo-100 dark:bg-indigo-900/40"></div>
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class DatabaseDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
  node = input.required<SimpleNode<DiagramNodeData>>();

  nodeData = computed(() => this.node().data);

  statusDotClass = computed(() => {
    const status = this.nodeData().status;
    return status ? (STATUS_DOT_COLORS[status] ?? '') : '';
  });
}
