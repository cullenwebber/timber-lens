import { TypeShape, objectShape, stringShape, unknownShape } from '../models/context';
import { AcfIndex } from './acfResolver';
import {
  ChainSegment,
  LoopScope,
  tokenizeChain,
} from '../parsers/twigContextParser';

/** Built-in Timber globals available as fallback completions. */
export const BUILTIN_GLOBALS = ['post', 'site', 'user', 'menu'];

export interface ResolverDeps {
  /** Variables passed into the current template via PHP. */
  contextVars: Map<string, TypeShape>;
  acf: AcfIndex;
  enableGlobals: boolean;
}

/**
 * Resolves Twig access chains to inferred type shapes, taking ACF, PHP context
 * and enclosing `for` loop variables into account.
 */
export class ContextResolver {
  private readonly postShape: TypeShape;

  constructor(private readonly deps: ResolverDeps) {
    this.postShape = buildPostShape(deps.acf);
  }

  /**
   * Compute the variable shapes introduced by a stack of enclosing loops.
   * Outer loops are resolved first so inner loops can depend on them.
   */
  buildLoopVars(loops: LoopScope[]): Map<string, TypeShape> {
    const loopVars = new Map<string, TypeShape>();
    for (const loop of loops) {
      const iterable = this.resolveExpr(loop.iterableExpr, loopVars);
      let itemShape: TypeShape;
      if (iterable && iterable.kind === 'array') {
        itemShape = iterable.item ?? unknownShape();
      } else {
        itemShape = unknownShape();
      }
      loopVars.set(loop.varName, itemShape);
    }
    return loopVars;
  }

  /** Resolve an expression string to a shape, or undefined. */
  resolveExpr(
    expr: string,
    loopVars: Map<string, TypeShape> = new Map()
  ): TypeShape | undefined {
    const segments = tokenizeChain(expr);
    if (!segments) {
      return undefined;
    }
    return this.resolveChain(segments, loopVars);
  }

  /** Resolve a tokenized chain to a shape, or undefined. */
  resolveChain(
    segments: ChainSegment[],
    loopVars: Map<string, TypeShape>
  ): TypeShape | undefined {
    if (segments.length === 0 || segments[0].type !== 'root') {
      return undefined;
    }
    let shape: TypeShape | undefined = this.resolveRoot(segments[0].name, loopVars);

    for (let i = 1; i < segments.length && shape; i++) {
      const seg = segments[i];
      if (seg.type === 'meta') {
        shape = this.deps.acf.shapeByName(seg.name);
      } else if (seg.type === 'prop') {
        shape = shape.kind === 'object' ? shape.keys?.get(seg.name) : undefined;
      } else if (seg.type === 'index') {
        shape = shape.kind === 'array' ? shape.item : undefined;
      }
    }
    return shape;
  }

  /** Resolve the root identifier of a chain. */
  resolveRoot(
    name: string,
    loopVars: Map<string, TypeShape>
  ): TypeShape | undefined {
    if (loopVars.has(name)) {
      return loopVars.get(name);
    }
    if (this.deps.contextVars.has(name)) {
      return this.deps.contextVars.get(name);
    }
    if (name === 'post') {
      return this.postShape;
    }
    if (name === 'site' || name === 'user' || name === 'menu') {
      return builtinGlobalShape(name);
    }
    return undefined;
  }

  get post(): TypeShape {
    return this.postShape;
  }
}

/**
 * Build the shape for the Timber `post` global: ACF top-level fields exposed as
 * direct properties, plus a handful of common Timber\Post properties.
 */
function buildPostShape(acf: AcfIndex): TypeShape {
  const keys = new Map<string, TypeShape>();

  // Common Timber\Post members.
  const builtins: Record<string, TypeShape> = {
    ID: { kind: 'number' },
    id: { kind: 'number' },
    title: stringShape(),
    name: stringShape(),
    slug: stringShape(),
    post_type: stringShape(),
    link: stringShape(),
    path: stringShape(),
    content: stringShape(),
    excerpt: stringShape(),
    date: stringShape(),
    modified: stringShape(),
    status: stringShape(),
    thumbnail: stringObjectShape(['src', 'url', 'alt', 'title']),
    author: stringObjectShape(['name', 'link', 'id']),
  };
  for (const [k, v] of Object.entries(builtins)) {
    keys.set(k, v);
  }

  // ACF top-level fields take precedence / add to the post shape.
  for (const field of acf.topLevelFields) {
    keys.set(field.name, acf.shapeByName(field.name) ?? unknownShape());
  }

  return objectShape(keys, { builtin: true, label: 'Timber post' });
}

function builtinGlobalShape(name: string): TypeShape {
  if (name === 'site') {
    return objectShape(
      new Map<string, TypeShape>([
        ['name', stringShape()],
        ['url', stringShape()],
        ['theme', stringObjectShape(['name', 'path', 'link'])],
        ['language', stringShape()],
        ['description', stringShape()],
      ]),
      { builtin: true, label: 'Timber site' }
    );
  }
  if (name === 'user') {
    return objectShape(
      new Map<string, TypeShape>([
        ['id', { kind: 'number' }],
        ['name', stringShape()],
        ['email', stringShape()],
        ['link', stringShape()],
      ]),
      { builtin: true, label: 'Timber user' }
    );
  }
  // menu
  return objectShape(
    new Map<string, TypeShape>([
      ['items', { kind: 'array', item: unknownShape() }],
      ['name', stringShape()],
    ]),
    { builtin: true, label: 'Timber menu' }
  );
}

function stringObjectShape(names: string[]): TypeShape {
  const map = new Map<string, TypeShape>();
  for (const n of names) {
    map.set(n, stringShape());
  }
  return objectShape(map);
}
