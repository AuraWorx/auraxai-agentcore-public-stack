import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramGroupNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  GroupNode,
} from 'ng-diagram';
import { DiagramNodeData, COLOR_ACCENTS } from './diagram-node-data.interface';

@Component({
  selector: 'app-group-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <div
        class="rounded-lg border-2 border-dashed select-none min-w-[200px] min-h-[120px]"
        [class]="nodeClasses()"
      >
        <div class="px-3 py-2 border-b border-inherit">
          <span class="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {{ nodeData().label }}
          </span>
        </div>
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class GroupDiagramNodeComponent implements NgDiagramGroupNodeTemplate<DiagramNodeData> {
  node = input.required<GroupNode<DiagramNodeData>>();

  nodeData = computed(() => this.node().data);

  nodeClasses = computed(() => {
    const color = this.nodeData().color;
    if (color && COLOR_ACCENTS[color]) {
      return COLOR_ACCENTS[color];
    }
    return 'bg-gray-50/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600';
  });
}
