/**
 * Package id - a number that uniquiely identifies both package and its dependencies.
 * There must be package with id 0 - which contains all the other packages.
 */
export type PackageId = number;

/**
 * Package name - a string that denotes the fact that two packages with the same name
 * cannot be dependencies of the same parent package. The package with the same name
 * can have multiple package ids associated with the packages, either because of the
 * different package versions, or because of the different dependency sets,
 * as in peer dependent package.
 */
export type PackageName = string;

/**
 * Package weight - a number that somehow signifies which package is heavier and should have
 * a priority to be hoisted. The packages having the biggest weight with all their transitive
 * dependencies are hoisted first.
 */
export type Weight = number;

export interface Dependencies
{
  deps: Set<PackageId>,
  peerDeps: Set<PackageId>
}

export interface ReadonlyDependencies
{
  deps: ReadonlySet<PackageId>,
  peerDeps: ReadonlySet<PackageId>
}

/**
 * Package tree - is simply an array, with index being package id and the value - the dependencies
 * of that package. Package tree can contain cycles.
 *
 * Hoisted package tree has the same type, but values should be treated as not necesseraly
 * dependencies, but rather hoisted packages.
 */
export type ReadonlyPackageTree = ReadonlyArray<ReadonlyDependencies>;
export type PackageTree = Dependencies[];
export type HoistedTree = Array<Set<PackageId>>;

/**
 * Initial information about the package.
 */
export interface PackageInfo {
  /** The name of the package */
  name: PackageName;
  /** The own weight of the package, without its transitive dependencies */
  weight: Weight;
}

/**
 * The results of weighting each package with its transitive dependencies in some subtree.
 */
type WeightMap = Map<PackageId, Weight>;
type ReadonlyWeightMap = ReadonlyMap<PackageId, Weight>;

/**
 * The raw hoister is responsible for transforming a tree of dependencies to reduce tree
 * height as much as possible. It uses the fact that if dependency is not found for some
 * package, it will be searched over the folder of its parent package dependencies. And
 * hence we can lift dependencies that have different names to the parent package "dependencies",
 * thus reducing tree height.
 */
export class RawHoister {
  /**
   * Hoists package tree, by applying hoisting algorithm to each tree node independently.
   * We first try to hoist all the packages from anywhere in the whole tree to the root package.
   * Then we apply the same algorithm to the subtree that starts at one of the dependencies of the
   * root package, we do this for each dependency, then move further down to dependencies of
   * dependencies, etc.
   *
   * This function does not mutate its arguments, it hoists and returns tree copy
   *
   * @param tree package tree (cycles in the tree are allowed)
   * @param packageInfos package infos
   * @param nohoist package ids that should be excluded from applying hoisting algorithm. Nohoist
   *                packages can be hoisted themselves, and their dependencies can be hoisted too,
   *                but only to the package itself, they cannot be hoisted to the nohoist package parent
   *
   * @returns hoisted tree copy
   */
  public hoist(tree: ReadonlyPackageTree, packageInfos: ReadonlyArray<PackageInfo>, nohoist: ReadonlySet<PackageId> = new Set()): HoistedTree {
    // Make tree copy, which will be mutated by hoisting algorithm
    const treeCopy: PackageTree = tree.map(({deps, peerDeps}) => ({deps: new Set(deps), peerDeps: new Set(peerDeps)}));

    const seenIds = new Set<PackageId>();

    const hoistSubTree = (nodeId: PackageId) => {
      seenIds.add(nodeId);

      // Apply mutating hoisting algorithm on each tree node starting from the root
      this.hoistInplace(treeCopy, nodeId, packageInfos, nohoist);

      for (const depId of treeCopy[nodeId].deps) {
        if (!seenIds.has(depId)) {
          hoistSubTree(depId);
        }
      }
    };

    if (treeCopy.length > 0 && treeCopy[0].deps.size > 0)
      hoistSubTree(0);

    return treeCopy.map(({deps}) => deps);
  }

  /**
   * Performs package subtree hoisting to its root.
   * This funtion mutates tree.
   *
   * @param tree package tree
   * @param rootId package subtree root package id
   * @param packages package infos
   * @param nohoist nohoist package ids
   */
  private hoistInplace(tree: PackageTree, rootId: PackageId, packages: ReadonlyArray<PackageInfo>, nohoist: ReadonlySet<PackageId>): void {
    // Get the list of package ids that can and should be hoisted to the subtree root
    const hoistedDepIds = this.computeHoistCandidates(tree, rootId, packages, nohoist);
    const seenIds = new Set<PackageId>();

    const removeHoistedDeps = (nodeId: PackageId) => {
      seenIds.add(nodeId);
      // No need to traverse past nohoist node
      if (nohoist.has(nodeId))
        return;

      const depIds = tree[nodeId].deps;
      for (const depId of depIds) {
        // First traverse to deeper levels
        if (!seenIds.has(depId))
          removeHoistedDeps(depId);

        // Then remove hoisted deps from current node
        if (hoistedDepIds.has(depId)) {
          depIds.delete(depId);
        }
      }
    };

    removeHoistedDeps(rootId);

    const nodeDepIds = tree[rootId].deps;
    for (const depId of hoistedDepIds) {
      // Add hoisted packages to the subtree root
      nodeDepIds.add(depId);
    }
  }

  /**
   * Weighs all the packages in the subtree, by adding up own package weight with weights of all
   * of its direct and transitive dependencies.
   *
   * @param tree package tree
   * @param rootId root package id of the subtree
   * @param packages package infos
   * @param nohoist nohoist package ids, that shouldn't be weighed
   *
   * @return map of package weights: package id -> total weight
   */
  private weighPackages(tree: ReadonlyPackageTree, rootId: PackageId, packages: ReadonlyArray<PackageInfo>, nohoist: ReadonlySet<PackageId>): WeightMap {
    const weights: WeightMap = new Map();
    const seenIds = new Set<PackageId>();

    const addUpNodeWeight = (nodeId: PackageId) => {
      seenIds.add(nodeId);

      if (!nohoist.has(nodeId)) {
        weights.set(nodeId, packages[nodeId].weight + (weights.get(nodeId) || 0));
        for (const depId of tree[nodeId].deps) {
          if (!seenIds.has(depId)) {
            addUpNodeWeight(depId);
          }
        }
      }
    };

    addUpNodeWeight(rootId);

    return weights;
  }

  /**
   * Finds packages that have the max weight among the packages with the same name
   *
   * @param weights package weights map: package id -> total weight
   * @param packages package infos
   *
   * @returns package ids with max weights among the packages with the same name
   */
  private getHeaviestPackages(weights: ReadonlyWeightMap, packages: ReadonlyArray<PackageInfo>): Set<PackageId> {
    const heaviestPackages = new Map<PackageName, {weight: Weight, pkgId: PackageId}>();
    for (const [pkgId, weight] of weights) {
      const pkgName = packages[pkgId].name;
      let heaviestPkg = heaviestPackages.get(pkgName);
      if (!heaviestPkg) {
        heaviestPkg = {weight, pkgId};
        heaviestPackages.set(pkgName, heaviestPkg);
      } else if (weight > heaviestPkg.weight) {
        heaviestPkg.weight = weight;
        heaviestPkg.pkgId = pkgId;
      }
    }

    const heavyPackageIds = new Set<PackageId>();
    for (const {pkgId} of heaviestPackages.values())
      heavyPackageIds.add(pkgId);

    return heavyPackageIds;
  }

  /**
   * Find the packages that can be hoisted to the subtree root `rootId`.
   *
   * @param tree package tree
   * @param rootId package id that should be regarded as subtree root
   * @param packages package infos
   * @param nohoist nohoist package ids
   */
  private computeHoistCandidates(tree: PackageTree, rootId: PackageId, packages: ReadonlyArray<PackageInfo>, nohoist: ReadonlySet<PackageId>): Set<PackageId> {
    // Get current package dependency package names
    const rootDepNames = new Map<PackageName, PackageId>();
    for (const depId of tree[rootId].deps)
      rootDepNames.set(packages[depId].name, depId);

    // Weigh all the packages in the subtree
    const packageWeights = this.weighPackages(tree, rootId, packages, nohoist);

    const hoistCandidateWeights: WeightMap = new Map();
    const hoistPeerDepCandidates = new Set<PackageId>();
    const seenPackageNames = new Set<PackageName>();
    const seenPackageIds = new Set<PackageId>();

    const findHoistCandidates = (nodeId: PackageId) => {
      seenPackageIds.add(nodeId);
      const name = packages[nodeId].name;
      // Package names that exist only in a single instance in the tree path are hoist candidates
      if (!seenPackageNames.has(name)) {
        seenPackageNames.add(name);
        const rootDepId = rootDepNames.get(name);
        // If the hoisting candidate has the same name as existing root subtree dependency,
        // we can only hoist it if its id is also the same
        // . → A → B@X → C → B@Y, - we can hoist only B@X here
        if (nodeId !== rootId && (!rootDepId || rootDepId === nodeId)) {
          const pkg = tree[nodeId];
          if (pkg.peerDeps.size > 0) {
            hoistPeerDepCandidates.add(nodeId);
          } else {
            hoistCandidateWeights.set(nodeId, packageWeights.get(nodeId)!);
          }
        }

        for (const depId of tree[nodeId].deps)
          if (!seenPackageIds.has(depId))
            findHoistCandidates(depId);

        seenPackageNames.delete(name);
      }
    };

    // Find packages names that are candidates for hoisting
    findHoistCandidates(rootId);

    // Among all hoist candidates choose the heaviest
    const hoistCandidates = this.getHeaviestPackages(hoistCandidateWeights, packages);

    let hoistCandidatesChanged;
    // Loop until hoist candidates set changes
    do {
      hoistCandidatesChanged = false;
      for (const peerDepCandId of hoistPeerDepCandidates) {
        const peerDeps = tree[peerDepCandId].peerDeps;
        for (const peerDepId of peerDeps)
          if (hoistCandidates.has(peerDepId))
            // Remove all the packages that are going to be hoisted from current peer deps
            peerDeps.delete(peerDepId);
        if (peerDeps.size === 0) {
          // Peer dependent package can be hoisted if all of its peer deps are going to be hoisted
          hoistCandidates.add(peerDepCandId);
          hoistPeerDepCandidates.delete(peerDepCandId);
          hoistCandidatesChanged = true;
        }
      }
    } while (hoistCandidatesChanged);

    return hoistCandidates;
  }
};