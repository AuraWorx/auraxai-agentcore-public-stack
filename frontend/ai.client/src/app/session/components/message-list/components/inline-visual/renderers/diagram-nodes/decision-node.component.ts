import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  SimpleNode,
} from 'ng-diagram';
import { DiagramNodeData, COLOR_ACCENTS } from './diagram-node-data.interface';

@Component({
  selector: 'app-decision-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <div class="flex items-center justify-center" style="min-width: 120px; min-height: 80px;">
        <div
          class="border-2 select-none flex items-center justify-center px-4 py-3"
          [class]="nodeClasses()"
          style="transform: rotate(45deg); min-width: 80px; min-height: 80px;"
        >
          <span
            class="text-sm font-medium text-gray-900 dark:text-white text-center"
            style="transform: rotate(-45deg);"
          >
            {{ nodeData().label }}
          </span>
        </div>
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
      <ng-diagram-port [id]="node().id + '-output-left'" type="source" side="left" />
      <ng-diagram-port [id]="node().id + '-output-right'" type="source" side="right" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class DecisionDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
  node = input.required<SimpleNode<DiagramNodeData>>();

  nodeData = computed(() => this.node().data);

  nodeClasses = computed(() => {
    const color = this.nodeData().color;
    if (color && COLOR_ACCENTS[color]) {
      return COLOR_ACCENTS[color];
    }
    return 'bg-amber-50 dark:bg-amber-900/30 border-amber-300 dark:border-amber-600';
  });
}
