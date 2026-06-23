import * as vscode from 'vscode';

export interface TimberLensSettings {
  twigRoots: string[];
  acfJsonPaths: string[];
  phpScanGlobs: string[];
  enableBuiltinGlobals: boolean;
  assumePostVariables: boolean;
}

const DEFAULTS: TimberLensSettings = {
  twigRoots: ['views', 'templates', 'components', 'blocks', 'partials'],
  acfJsonPaths: ['acf-json'],
  phpScanGlobs: ['**/*.php'],
  enableBuiltinGlobals: true,
  assumePostVariables: true,
};

export function getSettings(): TimberLensSettings {
  const cfg = vscode.workspace.getConfiguration('timberLens');
  return {
    twigRoots: cfg.get<string[]>('twigRoots', DEFAULTS.twigRoots),
    acfJsonPaths: cfg.get<string[]>('acfJsonPaths', DEFAULTS.acfJsonPaths),
    phpScanGlobs: cfg.get<string[]>('phpScanGlobs', DEFAULTS.phpScanGlobs),
    enableBuiltinGlobals: cfg.get<boolean>(
      'enableBuiltinGlobals',
      DEFAULTS.enableBuiltinGlobals
    ),
    assumePostVariables: cfg.get<boolean>(
      'assumePostVariables',
      DEFAULTS.assumePostVariables
    ),
  };
}
