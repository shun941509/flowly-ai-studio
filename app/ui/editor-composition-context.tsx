"use client";
import { createContext, useContext } from 'react';
import type { Definition, Resource, Workflow } from '../lib/model';
import type { RuntimeCapabilities } from '../../runtime/types';

export type CompositionContext={
 definition:Definition;buildRoot:(next:Definition)=>Definition;breadcrumbs:string[];
 resources:Resource[];capabilities?:RuntimeCapabilities|null;workflows:Workflow[];workflowId:string;
};
export const EditorCompositionContext=createContext<CompositionContext|null>(null);
export const useEditorComposition=()=>useContext(EditorCompositionContext);
