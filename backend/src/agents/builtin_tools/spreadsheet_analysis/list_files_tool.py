"""List available tabular files for spreadsheet analysis.

Factory function creates a context-bound tool that only exposes files
belonging to the current assistant's knowledge base or chat session.
"""

import logging
import os
from typing import Any, Dict, List, Optional

import boto3
from strands import tool

logger = logging.getLogger(__name__)

TABULAR_MIME_TYPES = {
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

TABULAR_EXTENSIONS = {".csv", ".xlsx"}


def _is_tabular_file(filename: str, content_type: str) -> bool:
    ext = os.path.splitext(filename)[1].lower()
    return content_type in TABULAR_MIME_TYPES or ext in TABULAR_EXTENSIONS


def make_list_files_tool(
    assistant_id: Optional[str],
    session_id: str,
    user_id: str,
):
    """Create a list_available_files tool bound to the given context."""

    @tool
    def list_available_files() -> Dict[str, Any]:
        """List spreadsheet files available for analysis.

        Returns CSV and XLSX files from the assistant's knowledge base
        and/or files attached to the current conversation. Use this to
        discover which files can be analyzed with the analyze_spreadsheet tool.

        Returns:
            Dictionary with 'files' list containing available tabular files,
            each with filename, source, content_type, size_bytes, and document_id.
        """
        files: List[Dict[str, Any]] = []

        # 1. Assistant KB files
        if assistant_id:
            files.extend(_get_kb_files(assistant_id))

        # 2. Session-attached files
        files.extend(_get_session_files(session_id))

        if not files:
            return {
                "content": [{"text": "No spreadsheet files (CSV or XLSX) are available. Upload a spreadsheet to the assistant's knowledge base or attach one to this conversation."}],
                "status": "success",
            }

        file_list = "\n".join(
            f"- {f['filename']} ({f['source']}, {f['size_bytes'] / 1024:.0f} KB)"
            for f in files
        )
        return {
            "content": [{"text": f"Available spreadsheet files:\n{file_list}"}],
            "status": "success",
            "files": files,
        }

    return list_available_files


def _get_kb_files(assistant_id: str) -> List[Dict[str, Any]]:
    """Query DynamoDB for completed tabular documents in the assistant's KB."""
    table_name = os.environ.get("DYNAMODB_ASSISTANTS_TABLE_NAME")
    if not table_name:
        logger.warning("DYNAMODB_ASSISTANTS_TABLE_NAME not set, skipping KB files")
        return []

    try:
        dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-west-2"))
        table = dynamodb.Table(table_name)

        response = table.query(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :sk_prefix)",
            ExpressionAttributeValues={":pk": f"AST#{assistant_id}", ":sk_prefix": "DOC#"},
        )

        files = []
        for item in response.get("Items", []):
            if item.get("status") != "complete":
                continue
            filename = item.get("filename", "")
            content_type = item.get("contentType", item.get("content_type", ""))
            if not _is_tabular_file(filename, content_type):
                continue
            files.append({
                "filename": filename,
                "source": "knowledge_base",
                "content_type": content_type,
                "size_bytes": int(item.get("sizeBytes", item.get("size_bytes", 0))),
                "document_id": item.get("documentId", item.get("document_id", "")),
                "s3_key": item.get("s3Key", item.get("s3_key", "")),
            })
        return files

    except Exception as e:
        logger.error(f"Error querying KB files for assistant {assistant_id}: {e}")
        return []


def _get_session_files(session_id: str) -> List[Dict[str, Any]]:
    """Query DynamoDB for tabular files attached to the current session."""
    try:
        from apis.shared.files.repository import get_file_upload_repository

        repo = get_file_upload_repository()

        import asyncio
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as executor:
                    session_files = executor.submit(asyncio.run, repo.list_session_files(session_id)).result()
            else:
                session_files = loop.run_until_complete(repo.list_session_files(session_id))
        except RuntimeError:
            session_files = asyncio.run(repo.list_session_files(session_id))

        files = []
        for f in session_files:
            if not _is_tabular_file(f.filename, f.mime_type):
                continue
            files.append({
                "filename": f.filename,
                "source": "chat_attachment",
                "content_type": f.mime_type,
                "size_bytes": f.size_bytes,
                "document_id": f.upload_id,
                "s3_key": f.s3_key,
                "s3_bucket": f.s3_bucket,
            })
        return files

    except Exception as e:
        logger.error(f"Error querying session files for {session_id}: {e}")
        return []
