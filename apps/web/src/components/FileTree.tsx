import type { FileTreeNode } from "../api";

type Props = {
  nodes: FileTreeNode[];
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
};

function TreeNode({ node, selectedPath, onOpenFile }: { node: FileTreeNode; selectedPath: string | null; onOpenFile: (path: string) => void }) {
  if (node.type === "directory") {
    return (
      <li>
        <details>
          <summary>{node.name}</summary>
          <ul>
            {node.children?.map((child) => (
              <TreeNode key={child.path} node={child} selectedPath={selectedPath} onOpenFile={onOpenFile} />
            ))}
          </ul>
        </details>
      </li>
    );
  }

  return (
    <li>
      <button className={selectedPath === node.path ? "tree-file selected" : "tree-file"} type="button" onClick={() => onOpenFile(node.path)}>
        {node.name}
      </button>
    </li>
  );
}

export default function FileTree({ nodes, selectedPath, onOpenFile }: Props) {
  return (
    <aside className="file-tree">
      <h2>文件树</h2>
      <ul>
        {nodes.map((node) => (
          <TreeNode key={node.path} node={node} selectedPath={selectedPath} onOpenFile={onOpenFile} />
        ))}
      </ul>
    </aside>
  );
}
