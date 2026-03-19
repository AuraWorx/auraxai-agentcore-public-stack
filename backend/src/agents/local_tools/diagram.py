"""
Diagram Tool - Strands Native
Creates ngDiagram specifications for frontend rendering of interactive node-edge diagrams.
Supports flowcharts, architecture diagrams, org charts, and custom graph topologies.
"""

import json
import logging
import math
from typing import Any, Literal
from strands import tool

logger = logging.getLogger(__name__)

# Supported diagram types
SUPPORTED_DIAGRAM_TYPES = ["flowchart", "architecture", "org_chart", "sequence", "mindmap", "custom"]

# Supported node types (must match frontend NgDiagramNodeTemplateMap keys)
SUPPORTED_NODE_TYPES = ["default", "process", "decision", "start", "end", "database", "service", "group"]

# Supported routing algorithms
SUPPORTED_ROUTING = ["orthogonal", "bezier", "polyline"]

# Default routing per diagram type
DEFAULT_ROUTING_MAP: dict[str, str] = {
    "flowchart": "orthogonal",
    "architecture": "bezier",
    "org_chart": "orthogonal",
    "sequence": "orthogonal",
    "mindmap": "bezier",
    "custom": "bezier",
}

# Default node dimensions per type
DEFAULT_NODE_SIZES: dict[str, dict[str, int]] = {
    "default": {"width": 160, "height": 60},
    "process": {"width": 180, "height": 70},
    "decision": {"width": 160, "height": 100},
    "start": {"width": 120, "height": 50},
    "end": {"width": 120, "height": 50},
    "database": {"width": 160, "height": 80},
    "service": {"width": 180, "height": 80},
    "group": {"width": 300, "height": 200},
}

# Default color palette for node status/categories
DEFAULT_COLORS: dict[str, str] = {
    "blue": "#3b82f6",
    "green": "#10b981",
    "amber": "#f59e0b",
    "red": "#ef4444",
    "purple": "#8b5cf6",
    "pink": "#ec4899",
    "teal": "#14b8a6",
    "gray": "#6b7280",
}


def _validate_nodes(nodes: list[dict[str, Any]]) -> tuple[bool, str | None]:
    """Validate node array structure."""
    if not nodes:
        return False, "Nodes array is empty. At least one node is required."

    seen_ids: set[str] = set()
    for i, node in enumerate(nodes):
        if "id" not in node:
            return False, f"Node at index {i} is missing required 'id' field."
        node_id = str(node["id"])
        if node_id in seen_ids:
            return False, f"Duplicate node id: '{node_id}'."
        seen_ids.add(node_id)

        if "type" not in node:
            return False, f"Node '{node_id}' is missing required 'type' field."

    return True, None


def _validate_edges(edges: list[dict[str, Any]], node_ids: set[str]) -> tuple[bool, str | None]:
    """Validate edge array structure and references."""
    for i, edge in enumerate(edges):
        source = edge.get("source")
        target = edge.get("target")

        if not source or not target:
            return False, f"Edge at index {i} is missing 'source' or 'target' field."

        if str(source) not in node_ids:
            return False, f"Edge at index {i} references unknown source node: '{source}'."
        if str(target) not in node_ids:
            return False, f"Edge at index {i} references unknown target node: '{target}'."

        routing = edge.get("routing")
        if routing and routing not in SUPPORTED_ROUTING:
            return False, f"Edge at index {i} has invalid routing: '{routing}'. Must be one of: {', '.join(SUPPORTED_ROUTING)}"

    return True, None


def _auto_assign_positions(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], diagram_type: str) -> list[dict[str, Any]]:
    """Assign grid-based positions to nodes that don't have explicit coordinates.

    Uses a simple layout algorithm based on diagram type.
    The frontend can override this with ELK.js for better results.
    """
    needs_layout = any(
        not node.get("position") or (node["position"].get("x", 0) == 0 and node["position"].get("y", 0) == 0)
        for node in nodes
    )

    if not needs_layout:
        return nodes

    result = []
    spacing_x = 250
    spacing_y = 150

    if diagram_type in ("flowchart", "sequence"):
        # Vertical flow: stack nodes top-to-bottom, attempt simple layering
        layers = _compute_layers(nodes, edges)
        for layer_idx, layer_nodes in enumerate(layers):
            layer_width = len(layer_nodes) * spacing_x
            start_x = -(layer_width - spacing_x) / 2
            for col_idx, node in enumerate(layer_nodes):
                if not node.get("position") or (node["position"].get("x", 0) == 0 and node["position"].get("y", 0) == 0):
                    node["position"] = {
                        "x": start_x + col_idx * spacing_x,
                        "y": layer_idx * spacing_y,
                    }
                result.append(node)
    elif diagram_type == "org_chart":
        # Tree layout: root at top, children below
        layers = _compute_layers(nodes, edges)
        for layer_idx, layer_nodes in enumerate(layers):
            layer_width = len(layer_nodes) * spacing_x
            start_x = -(layer_width - spacing_x) / 2
            for col_idx, node in enumerate(layer_nodes):
                if not node.get("position") or (node["position"].get("x", 0) == 0 and node["position"].get("y", 0) == 0):
                    node["position"] = {
                        "x": start_x + col_idx * spacing_x,
                        "y": layer_idx * spacing_y,
                    }
                result.append(node)
    elif diagram_type == "mindmap":
        # Radial layout from center node
        if nodes:
            center_node = nodes[0]
            center_node["position"] = {"x": 0, "y": 0}
            result.append(center_node)
            remaining = nodes[1:]
            angle_step = (2 * math.pi) / max(len(remaining), 1)
            radius = 300
            for i, node in enumerate(remaining):
                if not node.get("position") or (node["position"].get("x", 0) == 0 and node["position"].get("y", 0) == 0):
                    node["position"] = {
                        "x": round(radius * math.cos(i * angle_step)),
                        "y": round(radius * math.sin(i * angle_step)),
                    }
                result.append(node)
    else:
        # Grid layout fallback for architecture/custom
        cols = max(1, math.ceil(math.sqrt(len(nodes))))
        for i, node in enumerate(nodes):
            if not node.get("position") or (node["position"].get("x", 0) == 0 and node["position"].get("y", 0) == 0):
                row = i // cols
                col = i % cols
                node["position"] = {
                    "x": col * spacing_x,
                    "y": row * spacing_y,
                }
            result.append(node)

    return result if result else nodes


def _compute_layers(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Compute topological layers for hierarchical layout.

    Nodes with no incoming edges go to layer 0, their children to layer 1, etc.
    """
    node_map = {str(n["id"]): n for n in nodes}
    incoming: dict[str, set[str]] = {str(n["id"]): set() for n in nodes}
    outgoing: dict[str, list[str]] = {str(n["id"]): [] for n in nodes}

    for edge in edges:
        src = str(edge["source"])
        tgt = str(edge["target"])
        if src in incoming and tgt in incoming:
            incoming[tgt].add(src)
            outgoing[src].append(tgt)

    # Assign layers via BFS
    layer_assignment: dict[str, int] = {}
    # Start with root nodes (no incoming edges)
    roots = [nid for nid, inc in incoming.items() if not inc]
    if not roots:
        # If cyclic, just pick the first node
        roots = [str(nodes[0]["id"])] if nodes else []

    queue = [(nid, 0) for nid in roots]
    while queue:
        nid, layer = queue.pop(0)
        if nid in layer_assignment:
            layer_assignment[nid] = max(layer_assignment[nid], layer)
            continue
        layer_assignment[nid] = layer
        for child in outgoing.get(nid, []):
            queue.append((child, layer + 1))

    # Assign any unvisited nodes to layer 0
    for nid in node_map:
        if nid not in layer_assignment:
            layer_assignment[nid] = 0

    # Group by layer
    max_layer = max(layer_assignment.values()) if layer_assignment else 0
    layers: list[list[dict[str, Any]]] = [[] for _ in range(max_layer + 1)]
    for nid, layer in layer_assignment.items():
        layers[layer].append(node_map[nid])

    return layers


def _normalize_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize node data to ensure consistent structure."""
    result = []
    for node in nodes:
        normalized: dict[str, Any] = {
            "id": str(node["id"]),
            "type": node.get("type", "default"),
            "data": node.get("data", {}),
            "position": node.get("position", {"x": 0, "y": 0}),
        }

        # Ensure data has at least a label
        if "label" not in normalized["data"]:
            normalized["data"]["label"] = normalized["id"]

        # Set default dimensions based on node type
        node_type = normalized["type"]
        defaults = DEFAULT_NODE_SIZES.get(node_type, DEFAULT_NODE_SIZES["default"])
        normalized["width"] = node.get("width", defaults["width"])
        normalized["height"] = node.get("height", defaults["height"])

        # Carry over optional properties
        if "rotatable" in node:
            normalized["rotatable"] = node["rotatable"]
        if "resizable" in node:
            normalized["resizable"] = node["resizable"]

        result.append(normalized)
    return result


def _normalize_edges(edges: list[dict[str, Any]], default_routing: str) -> list[dict[str, Any]]:
    """Normalize edge data, auto-generating IDs and ports as needed."""
    result = []
    for i, edge in enumerate(edges):
        normalized: dict[str, Any] = {
            "id": str(edge.get("id", f"edge-{i}")),
            "source": str(edge["source"]),
            "target": str(edge["target"]),
            "sourcePort": edge.get("sourcePort", f"{edge['source']}-output"),
            "targetPort": edge.get("targetPort", f"{edge['target']}-input"),
            "routing": edge.get("routing", default_routing),
        }

        # Optional edge properties
        if "label" in edge:
            normalized["label"] = edge["label"]
        if "data" in edge:
            normalized["data"] = edge["data"]

        result.append(normalized)
    return result


def _build_default_ports(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add default input/output ports to nodes if not already present."""
    result = []
    for node in nodes:
        if "ports" not in node:
            node_type = node.get("type", "default")
            if node_type == "start":
                node["ports"] = [
                    {"id": f"{node['id']}-output", "type": "source", "side": "bottom"},
                ]
            elif node_type == "end":
                node["ports"] = [
                    {"id": f"{node['id']}-input", "type": "target", "side": "top"},
                ]
            elif node_type == "decision":
                node["ports"] = [
                    {"id": f"{node['id']}-input", "type": "target", "side": "top"},
                    {"id": f"{node['id']}-output", "type": "source", "side": "bottom"},
                    {"id": f"{node['id']}-output-left", "type": "source", "side": "left"},
                    {"id": f"{node['id']}-output-right", "type": "source", "side": "right"},
                ]
            else:
                node["ports"] = [
                    {"id": f"{node['id']}-input", "type": "target", "side": "top"},
                    {"id": f"{node['id']}-output", "type": "source", "side": "bottom"},
                ]
        result.append(node)
    return result


@tool
def create_diagram(
    diagram_type: Literal["flowchart", "architecture", "org_chart", "sequence", "mindmap", "custom"],
    nodes: list[dict[str, Any]],
    title: str = "",
    edges: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> str:
    """
    Create interactive node-edge diagrams rendered inline in the conversation.

    This tool generates ngDiagram specifications that the frontend renders as
    interactive diagrams. Use this for visualizing relationships, flows, architectures,
    and hierarchies. For quantitative data, use create_visualization instead.

    Args:
        diagram_type: Type of diagram to create:
            - "flowchart": Process flows with decision points (orthogonal routing)
            - "architecture": System architecture with services and databases (bezier routing)
            - "org_chart": Organizational hierarchy (orthogonal routing)
            - "sequence": Sequential process steps (orthogonal routing)
            - "mindmap": Radial concept map from central topic (bezier routing)
            - "custom": Free-form diagram with manual layout
        nodes: Array of node objects. Each node must have:
            - "id": Unique string identifier
            - "type": Node template type, one of:
                - "default": Simple rounded rectangle with label
                - "process": Rectangle with label and description
                - "decision": Diamond shape for branching logic
                - "start": Rounded pill for flow entry points
                - "end": Double-bordered pill for flow endpoints
                - "database": Cylinder shape for data stores
                - "service": Rectangle with icon for system services
                - "group": Container for grouping child nodes
            - "data": Object with node content:
                - "label" (required): Display text
                - "description" (optional): Secondary text
                - "icon" (optional): Icon identifier
                - "status" (optional): "active" | "warning" | "error" | "inactive"
                - "color" (optional): Color key from palette (blue, green, amber, red, purple, pink, teal, gray)
            - "position" (optional): {"x": number, "y": number} - auto-calculated if omitted
            - "width" (optional): Node width in pixels (defaults per type)
            - "height" (optional): Node height in pixels (defaults per type)
        title: Diagram title displayed above the visualization
        edges: Array of edge (connection) objects. Each edge needs:
            - "source": Source node ID
            - "target": Target node ID
            - "id" (optional): Unique edge identifier (auto-generated if omitted)
            - "sourcePort" (optional): Port ID on source node (defaults to "{source}-output")
            - "targetPort" (optional): Port ID on target node (defaults to "{target}-input")
            - "label" (optional): Text label on the edge
            - "routing" (optional): "orthogonal" | "bezier" | "polyline" (defaults per diagram type)
        config: Optional global configuration overrides:
            - "direction": "TB" | "LR" | "BT" | "RL" (layout direction)
            - "spacing": {"x": number, "y": number} (node spacing)
            - "defaultRouting": "orthogonal" | "bezier" | "polyline"

    Returns:
        Diagram specification rendered inline in conversation

    Examples:
        # Simple flowchart
        create_diagram(
            diagram_type="flowchart",
            title="User Login Flow",
            nodes=[
                {"id": "start", "type": "start", "data": {"label": "Start"}},
                {"id": "login", "type": "process", "data": {"label": "Enter Credentials", "description": "Username and password"}},
                {"id": "check", "type": "decision", "data": {"label": "Valid?"}},
                {"id": "dashboard", "type": "process", "data": {"label": "Dashboard", "status": "active"}},
                {"id": "error", "type": "process", "data": {"label": "Show Error", "status": "error"}},
                {"id": "end", "type": "end", "data": {"label": "End"}}
            ],
            edges=[
                {"source": "start", "target": "login"},
                {"source": "login", "target": "check"},
                {"source": "check", "target": "dashboard", "label": "Yes"},
                {"source": "check", "target": "error", "label": "No", "sourcePort": "check-output-right"},
                {"source": "error", "target": "login", "label": "Retry"},
                {"source": "dashboard", "target": "end"}
            ]
        )

        # Architecture diagram
        create_diagram(
            diagram_type="architecture",
            title="Microservices Architecture",
            nodes=[
                {"id": "gateway", "type": "service", "data": {"label": "API Gateway", "icon": "gateway"}},
                {"id": "auth", "type": "service", "data": {"label": "Auth Service", "color": "green"}},
                {"id": "users", "type": "service", "data": {"label": "User Service", "color": "blue"}},
                {"id": "db", "type": "database", "data": {"label": "PostgreSQL"}},
            ],
            edges=[
                {"source": "gateway", "target": "auth"},
                {"source": "gateway", "target": "users"},
                {"source": "auth", "target": "db"},
                {"source": "users", "target": "db"},
            ]
        )

        # Org chart
        create_diagram(
            diagram_type="org_chart",
            title="Engineering Team",
            nodes=[
                {"id": "cto", "type": "default", "data": {"label": "CTO", "description": "Jane Smith"}},
                {"id": "fe-lead", "type": "default", "data": {"label": "FE Lead", "description": "Bob"}},
                {"id": "be-lead", "type": "default", "data": {"label": "BE Lead", "description": "Alice"}},
                {"id": "dev1", "type": "default", "data": {"label": "Developer", "description": "Charlie"}},
                {"id": "dev2", "type": "default", "data": {"label": "Developer", "description": "Diana"}},
            ],
            edges=[
                {"source": "cto", "target": "fe-lead"},
                {"source": "cto", "target": "be-lead"},
                {"source": "fe-lead", "target": "dev1"},
                {"source": "be-lead", "target": "dev2"},
            ]
        )

        # Mindmap
        create_diagram(
            diagram_type="mindmap",
            title="Project Planning",
            nodes=[
                {"id": "center", "type": "default", "data": {"label": "Project X", "color": "purple"}},
                {"id": "frontend", "type": "default", "data": {"label": "Frontend", "color": "blue"}},
                {"id": "backend", "type": "default", "data": {"label": "Backend", "color": "green"}},
                {"id": "infra", "type": "default", "data": {"label": "Infrastructure", "color": "amber"}},
                {"id": "testing", "type": "default", "data": {"label": "Testing", "color": "red"}},
            ],
            edges=[
                {"source": "center", "target": "frontend"},
                {"source": "center", "target": "backend"},
                {"source": "center", "target": "infra"},
                {"source": "center", "target": "testing"},
            ]
        )
    """
    try:
        # Validate diagram type
        if diagram_type not in SUPPORTED_DIAGRAM_TYPES:
            error_dict = {
                "success": False,
                "error": f"Invalid diagram type: {diagram_type}. Must be one of: {', '.join(SUPPORTED_DIAGRAM_TYPES)}"
            }
            return json.dumps(error_dict)

        # Validate nodes
        is_valid, error_msg = _validate_nodes(nodes)
        if not is_valid:
            error_dict = {
                "success": False,
                "error": error_msg,
                "diagram_type": diagram_type
            }
            return json.dumps(error_dict)

        # Default edges to empty list
        edges_list = edges or []

        # Validate edges reference valid node IDs
        node_ids = {str(n["id"]) for n in nodes}
        is_valid, error_msg = _validate_edges(edges_list, node_ids)
        if not is_valid:
            error_dict = {
                "success": False,
                "error": error_msg,
                "diagram_type": diagram_type
            }
            return json.dumps(error_dict)

        # Determine default routing for this diagram type
        default_routing = DEFAULT_ROUTING_MAP.get(diagram_type, "bezier")
        if config and "defaultRouting" in config:
            if config["defaultRouting"] in SUPPORTED_ROUTING:
                default_routing = config["defaultRouting"]

        # Normalize nodes and edges
        normalized_nodes = _normalize_nodes(nodes)
        normalized_edges = _normalize_edges(edges_list, default_routing)

        # Add default ports
        normalized_nodes = _build_default_ports(normalized_nodes)

        # Auto-assign positions for nodes without explicit coordinates
        normalized_nodes = _auto_assign_positions(normalized_nodes, normalized_edges, diagram_type)

        # Build config
        diagram_config: dict[str, Any] = {
            "defaultRouting": default_routing,
            "direction": "TB",
        }
        if config:
            diagram_config.update(config)

        logger.info(f"Created {diagram_type} diagram '{title}' with {len(normalized_nodes)} nodes and {len(normalized_edges)} edges")

        # Return with UI discriminators for inline rendering
        result_dict = {
            "success": True,
            # UI discriminators for frontend inline rendering
            "ui_type": "diagram",
            "ui_display": "inline",
            # ngDiagram payload
            "payload": {
                "diagramType": diagram_type,
                "title": title,
                "nodes": normalized_nodes,
                "edges": normalized_edges,
                "config": diagram_config,
            },
            # Human-readable summary for fallback display
            "summary": f"Created {diagram_type} diagram '{title}' with {len(normalized_nodes)} nodes and {len(normalized_edges)} edges"
        }

        return json.dumps(result_dict)

    except Exception as e:
        logger.error(f"Error creating diagram: {e}")
        error_dict = {
            "success": False,
            "error": str(e),
            "diagram_type": diagram_type
        }
        return json.dumps(error_dict)
