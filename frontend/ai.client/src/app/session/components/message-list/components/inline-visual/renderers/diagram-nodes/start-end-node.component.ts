import { Component, computed, input, ChangeDetectionStrategy } from '@angular/core';
import {
  NgDiagramNodeTemplate,
  NgDiagramBaseNodeTemplateComponent,
  NgDiagramPortComponent,
  SimpleNode,
} from 'ng-diagram';
import { DiagramNodeData } from './diagram-node-data.interface';

@Component({
  selector: 'app-start-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <div class="px-6 py-2.5 rounded-full border-2 border-green-400 dark:border-green-500
                  bg-green-50 dark:bg-green-900/30 select-none text-center min-w-[80px]">
        <span class="text-sm font-medium text-green-700 dark:text-green-300">
          {{ nodeData().label }}
        </span>
      </div>
      <ng-diagram-port [id]="node().id + '-output'" type="source" side="bottom" />
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class StartDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
  node = input.required<SimpleNode<DiagramNodeData>>();
  nodeData = computed(() => this.node().data);
}

@Component({
  selector: 'app-end-diagram-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgDiagramBaseNodeTemplateComponent, NgDiagramPortComponent],
  template: `
    <ng-diagram-base-node-template [node]="node()">
      <ng-diagram-port [id]="node().id + '-input'" type="target" side="top" />
      <div class="px-6 py-2.5 rounded-full border-[3px] border-red-400 dark:border-red-500
                  bg-red-50 dark:bg-red-900/30 select-none text-center min-w-[80px]">
        <span class="text-sm font-medium text-red-700 dark:text-red-300">
          {{ nodeData().label }}
        </span>
      </div>
    </ng-diagram-base-node-template>
  `,
  styles: `:host { display: block; }`,
})
export class EndDiagramNodeComponent implements NgDiagramNodeTemplate<DiagramNodeData> {
  node = input.required<SimpleNode<DiagramNodeData>>();
  nodeData = computed(() => this.node().data);
}
